import { admin } from '@/lib/db/client'
import { issuedUnderFormerKey, lookupFormerKey, type KeyRename } from './project-keys'
import { isLabEnabled } from './lab-settings'
import { subjectRefQuery } from './lab-shape'
import { getSubjectByNumber, type Subject } from './subjects'

/**
 * Query construction for prior-work discovery.
 *
 * Postgres full-text search ANDs the terms of a websearch query, which is the
 * right default for precision: an agent searching "supavisor pool timeouts"
 * wants the task about exactly that. It is the wrong behaviour when the agent
 * words the subject differently from whoever filed it, which is most of the
 * time — and a zero-result search reads as "this is new", the single most
 * expensive wrong answer this system can give.
 *
 * That was answered for years by trying the precise query first and widening
 * only when it came back thin, which is the shape `search_tasks` still has.
 * CAIRN-247 measured what it cost in `search_all`: an AND over every content
 * word of a 9-13 word question matched the expected row 3 times in 22 live
 * searches, and the rows it DID match — long descriptions that happen to
 * contain every word somewhere — were enough to switch the widened arm off.
 * Three irrelevant rows suppressed the arm that answers the question.
 *
 * So, since migration 055: both arms always run and are merged. The precise
 * arm is no longer "every word of the sentence" but at least half of
 * `distinctiveTerms()`, counted per row, which is a superset of what it used
 * to match; the wide arm is the same OR it always was; and a row found by both
 * appears once, in the precise head.
 */

/** Words too common to be worth ORing on; they would match half the corpus. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'why', 'how', 'are', 'was', 'were', 'not', '但', 'les', 'des', 'une', 'dans',
  'pour', 'avec', 'sur', 'est', 'sont', 'pas', 'que', 'qui',
])

export const distinctiveTerms = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ].slice(0, 8)

/**
 * The distinctive terms, passed to the database as an array.
 *
 * The database needs the terms individually, not pre-joined: it ranks widened
 * results by how many DISTINCT terms a row matches, which cannot be recovered
 * from an already-ORed string.
 */
export const widenedTerms = (query: string): string[] | null => {
  const terms = distinctiveTerms(query)
  return terms.length >= 2 ? terms : null
}

export type SearchRow = {
  id: string
  number: number
  title: string
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  description: string | null
  claimed_by: string | null
  updated_at: string
  external_ref: string | null
  project_key: string
  rank: number
  coverage: number
  widened: boolean
  /** Set only when the query was a ref through a retired key (CAIRN-264). */
  requested_ref?: string
  renamed_from?: KeyRename
}

/**
 * Ranking happens in Postgres, via the search_tasks function.
 *
 * ts_rank needs the tsvector and tsquery together, and PostgREST cannot order
 * by an expression it did not select — so ordering here would mean ordering by
 * something other than relevance. Doing exactly that (recency) dropped
 * measured recall from 75% to 6%: widening returns many more rows, and a
 * recency sort buries the exact match among them.
 */
/**
 * A ref is an exact address, not a phrase to match.
 *
 * Searching `CAIRN-131` returned CAIRN-105 — the task whose resolution
 * mentions it — and never 131 itself; searching `CAIRN-106` returned nothing at
 * all. The ref is a project key plus a number, and the key lives in another
 * table, so no generated column on `tasks` can reach it and the vector has
 * never contained it.
 *
 * That matters more here than it looks. A ref is designed to escape into
 * commits, notes and transcripts precisely so it can be pasted back, and
 * `cairn check` is the verb every agent is told to run first. Pasting one in
 * got you everything that mentions it and never the thing you asked for.
 *
 * So a ref-shaped query is resolved directly and put first, and the full-text
 * pass still runs underneath it — what references this task is a genuinely
 * useful second answer, just not the only one.
 */
const REF_QUERY = /^\s*([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\s*$/

/**
 * A bare number is an address too.
 *
 * Typing `131` while looking at a project is how a person refers to a task —
 * the key is the thing they already know and do not repeat. It returned twenty
 * rows of prose that happen to contain those digits, and not the task.
 *
 * Without a project it is genuinely ambiguous: CAIRN-131, OD-131 and HM-131 can
 * all exist. All of them are returned rather than one being guessed at, each
 * carrying its own ref, and capped — someone searching `404` or `500` wants the
 * error, and a handful of same-numbered tasks ahead of it is a nudge where
 * twenty would be an obstruction.
 */
const NUMBER_QUERY = /^\s*(\d{1,6})\s*$/

/**
 * The same columns a ranked row carries. A row assembled here renders in the
 * same list, so a stubbed priority or a missing claim would read as fact.
 */
const EXACT_COLUMNS =
  'id, number, title, description, type, status, priority, resolution, ' +
  'resolution_kind, claimed_by, external_ref, updated_at, ' +
  'project:projects!project_id!inner(key, owner_user_id)'
const BARE_NUMBER_LIMIT = 5

type ExactTask = {
  id: string
  number: number
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  external_ref: string | null
  updated_at: string
  created_at?: string
  project: { key: string } | { key: string }[] | null
  /** How the ref reached it, when that was through a retired key. */
  requested_ref?: string
  renamed_from?: KeyRename
}

const keyOfProject = (project: ExactTask['project']) =>
  (Array.isArray(project) ? project[0]?.key : project?.key) ?? null

/**
 * The task a ref names, including through a key the project used to have —
 * the whole point of retaining former keys is that old refs keep resolving.
 */
const tasksByNumber = async (
  _userId: string,
  q: string,
  project?: string,
): Promise<ExactTask[]> => {
  const match = NUMBER_QUERY.exec(q)
  if (!match?.[1]) return []

  let query = admin()
    .from('tasks')
    .select(EXACT_COLUMNS)
    .eq('number', Number(match[1]))
  if (project) query = query.eq('projects.key', project.toUpperCase())

  const { data } = await query
    .order('updated_at', { ascending: false })
    .limit(BARE_NUMBER_LIMIT)
  return (data ?? []) as unknown as ExactTask[]
}

const taskByRef = async (_userId: string, q: string): Promise<ExactTask | null> => {
  const match = REF_QUERY.exec(q)
  if (!match?.[1] || !match[2]) return null
  const key = match[1].toUpperCase()
  const number = Number(match[2])

  const columns = EXACT_COLUMNS

  const { data } = await admin()
    .from('tasks')
    .select(columns)
    .eq('projects.key', key)
    .eq('number', number)
    .maybeSingle()

  if (data) return data as unknown as ExactTask

  const former = await lookupFormerKey(key)
  if (!former) return null

  const { data: byFormer } = await admin()
    .from('tasks')
    .select(`${columns}, created_at`)
    .eq('project_id', former.projectId)
    .eq('number', number)
    .maybeSingle()

  const task = (byFormer as unknown as ExactTask | null) ?? null
  if (!task) return null
  // HOL-114, filed after AC became HOL, was never AC-114. Answering the old
  // spelling with it would invent a ref, so the exact path stays out of it and
  // the ordinary search answers instead.
  if (!issuedUnderFormerKey(former.rename, task.created_at)) return null
  // Said, not just done: the caller asked for AC-113 and is handed HOL-113,
  // and without this cannot tell it is the same task.
  return { ...task, requested_ref: `${key}-${number}`, renamed_from: former.rename }
}

/** A subject a `LAB-12` query names, as a search row: above every ranked hit. */
const asSubjectRow = (subject: Subject): SearchAllRow => ({
  kind: 'subject',
  id: subject.id,
  ref: subject.ref,
  title: subject.title,
  subtitle: subject.conclusion?.replace(/\s+/g, ' ').slice(0, 120) || null,
  project_key: subject.project?.key ?? null,
  status: subject.stage.name,
  type: 'subject',
  answered: subject.conclusion !== null,
  updated_at: subject.updated_at,
  body_bytes: (subject.body?.length ?? 0) + (subject.conclusion?.length ?? 0),
  rank: Number.POSITIVE_INFINITY,
  widened: false,
})

const asSearchAllRow = (task: ExactTask): SearchAllRow => ({
  kind: 'task',
  id: task.id,
  ref: `${keyOfProject(task.project)}-${task.number}`,
  title: task.title,
  subtitle: task.description?.slice(0, 200) ?? null,
  project_key: keyOfProject(task.project),
  status: task.status,
  type: task.type,
  answered: Boolean(task.resolution),
  updated_at: task.updated_at,
  body_bytes: (task.description?.length ?? 0) + (task.resolution?.length ?? 0),
  // Above every ranked hit on purpose: an exact address outranks a mention.
  rank: Number.POSITIVE_INFINITY,
  widened: false,
  ...(task.renamed_from ? { requested_ref: task.requested_ref, renamed_from: task.renamed_from } : {}),
})

/**
 * How many ranked rows an assignee filter chooses from. `search_tasks` applies
 * its limit inside the ranking, so narrowing its answer afterwards would return
 * two of someone's tasks out of twenty hits rather than twenty of theirs. A
 * larger pool keeps the order — the precise head is capped by p_min_precise,
 * not p_limit, so the first rows are the same rows — and the filter stays
 * here rather than in a fourth rewrite of the function's text (CAIRN-310).
 */
const ASSIGNEE_POOL = 200

/**
 * Only the tasks one person is assigned. The filter a caller sets is a
 * statement about what they want back, exact addresses included.
 */
export const searchTasks = async (
  userId: string,
  q: string,
  { assignee, ...filters }: { project?: string; type?: string; status?: string; assignee?: string },
  limit: number,
): Promise<{ rows: SearchRow[]; widened: boolean }> => {
  if (!assignee) return rankTasks(userId, q, filters, limit)

  const { rows } = await rankTasks(userId, q, filters, Math.max(limit, ASSIGNEE_POOL))
  if (rows.length === 0) return { rows, widened: false }
  const { data } = await admin()
    .from('tasks')
    .select('id')
    .in('id', rows.map((row) => row.id))
    .eq('assignee_user_id', assignee)
  const theirs = new Set(((data ?? []) as { id: string }[]).map((task) => task.id))
  const kept = rows.filter((row) => theirs.has(row.id)).slice(0, limit)
  return { rows: kept, widened: kept.some((row) => row.widened) }
}

const rankTasks = async (
  userId: string,
  q: string,
  filters: { project?: string; type?: string; status?: string },
  limit: number,
): Promise<{ rows: SearchRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_tasks', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: filters.project ?? null,
    p_type: filters.type ?? null,
    p_status: filters.status ?? null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchRow[]

  // Same rule on the task-only path, which is what the UI uses the moment a
  // type or status filter is set — and what `cairn check --tasks` uses.
  const byRef = await taskByRef(userId, q)
  const addressed = byRef ? [byRef] : await tasksByNumber(userId, q, filters.project)
  if (addressed.length === 0) return { rows, widened: rows.some((r) => r.widened) }

  // A filter the caller set is a statement about what they want back; an exact
  // address does not override it.
  const kept = addressed.filter((task) => {
    const key = keyOfProject(task.project)
    if (filters.project && filters.project.toUpperCase() !== key) return false
    if (filters.type && filters.type !== task.type) return false
    if (filters.status && filters.status !== task.status) return false
    return true
  })
  if (kept.length === 0) return { rows, widened: rows.some((r) => r.widened) }

  const heads: SearchRow[] = kept.map((task) => ({
    id: task.id,
    number: task.number,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    resolution: task.resolution,
    resolution_kind: task.resolution_kind,
    description: task.description,
    claimed_by: task.claimed_by,
    updated_at: task.updated_at,
    external_ref: task.external_ref,
    project_key: keyOfProject(task.project) ?? '',
    rank: Number.POSITIVE_INFINITY,
    coverage: 1,
    widened: false,
    ...(task.renamed_from ? { requested_ref: task.requested_ref, renamed_from: task.renamed_from } : {}),
  }))

  const headIds = new Set(heads.map((h) => h.id))
  const deduped = [...heads, ...rows.filter((r) => !headIds.has(r.id))]
  return { rows: deduped.slice(0, limit), widened: rows.some((r) => r.widened) }
}

/**
 * The unified index: tasks, work-log notes, knowledge and sessions.
 *
 * `search_tasks` above is kept because the UI and the duplicate probe both
 * want tasks and only tasks. This is what `cairn check` calls, because the
 * agent asking "has this been done or debugged" does not care which table the
 * answer happens to live in — and for two years the answer most likely to
 * exist, a work-log note, was the one table nothing searched.
 */
export type SearchAllRow = {
  kind: 'task' | 'note' | 'knowledge' | 'session' | 'subject'
  id: string
  ref: string
  title: string
  subtitle: string | null
  project_key: string | null
  status: string | null
  type: string | null
  answered: boolean
  updated_at: string
  body_bytes: number
  rank: number
  widened: boolean
  requested_ref?: string
  renamed_from?: KeyRename
}

export const searchAll = async (
  userId: string,
  q: string,
  filters: { project?: string; kinds?: string[] },
  limit: number,
): Promise<{ rows: SearchAllRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_all', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: filters.project ?? null,
    p_kinds: filters.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchAllRow[]

  // The task an address names, first, and never twice: the full-text pass can
  // also find it legitimately, by title.
  const wantsTasks = !filters.kinds || filters.kinds.includes('task')
  const addressed = wantsTasks
    ? await (async () => {
        const byRef = await taskByRef(userId, q)
        return byRef ? [byRef] : await tasksByNumber(userId, q, filters.project)
      })()
    : []

  // `LAB-12` names a Lab subject (docs/lab.md): resolved directly and put
  // first, the way a task ref is, while the Lab is on.
  const wantsSubjects = !filters.kinds || filters.kinds.includes('subject')
  const subjectNumber = wantsSubjects ? subjectRefQuery(q) : null
  const found = subjectNumber && (await isLabEnabled()) ? await getSubjectByNumber(subjectNumber) : null
  // A project-scoped search pins it only when it belongs to that project, as
  // the full-text arm only returns that project's subjects.
  const subject =
    found && (!filters.project || found.project?.key === filters.project.toUpperCase()) ? found : null

  const addressedIds = new Set(addressed.map((t) => t.id))
  const head = [...(subject ? [asSubjectRow(subject)] : []), ...addressed.map(asSearchAllRow)]
  const withExact =
    head.length > 0
      ? [
          ...head,
          ...rows.filter((r) => !(r.kind === 'task' && addressedIds.has(r.id)) && !(r.kind === 'subject' && r.id === subject?.id)),
        ]
      : rows

  /**
   * Widened describes the full-text pass. An exact hit is not a loose match and
   * must not make the caller think the rest were precise — so it is read off
   * `rows`, never off the addressed head.
   *
   * "Any row was loose" stopped meaning anything the moment 055 made both arms
   * run: nearly every search returns some loose row, and a flag that is almost
   * always true would have quietly turned the widening rate on the Vitals page
   * — whose own caption is "a search that widened is one the precise question
   * could not answer" — into a constant, and `cairn check`'s "treat this
   * subject as new" warning into noise printed over correct answers.
   *
   * What the flag is for is unchanged, so it is derived from the thing that
   * still carries that meaning: NOTHING cleared the precise arm. Zero rows is
   * not widening, it is `zeroResults`, which 024 counts separately.
   */
  const anyPrecise = rows.some((r) => !r.widened)
  return { rows: withExact.slice(0, limit), widened: rows.length > 0 && !anyPrecise }
}
