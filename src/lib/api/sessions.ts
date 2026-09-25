import { admin } from '@/lib/db/client'
import { resolveProject } from './project-keys'
import { projectForCheckoutName, projectForCwd, projectForRepo } from './project-resolution'
import type { Actor } from './auth'
import { actorLabel } from './actor'
import type { SessionUpsert } from '@/schemas/session'
import { recordFiles } from './files'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import { AUTO_CHECKPOINT_MARKER, UNTOUCHED_CHECKPOINT_PREFIX, isAutoCheckpoint } from '@/lib/checkpoint-origin'

/**
 * Sessions: the episodic record, checkpointed during and written at the end of one.
 *
 * This is the half of memory an agent cannot be trusted to write on purpose,
 * so nothing here depends on it choosing to. A session-end hook posts what the
 * transcript already contains; the only judgement involved is four prose
 * fields, and a session with none of them is still worth the row.
 *
 * Idempotent on (platform_source, external_id) because that is a correctness
 * requirement, not a nicety: Codex has no session-end event so its writer runs
 * on Stop, which fires once per turn, and OpenClaw's runs from a reconciler
 * that may sweep a session the hook already recorded.
 */

const COLUMNS =
  'id, external_id, platform_source, agent_id, cwd, project_id, started_at, ended_at, ' +
  'request, learned, completed, next_steps, files, task_refs, tool_calls, scheduled, created_at, updated_at'

export type SessionRow = {
  id: string
  /** Full DB timestamp precision for keyset pagination (JS Date loses microseconds). */
  cursor_ended_at?: string | null
  external_id: string
  platform_source: string
  agent_id: string | null
  cwd: string | null
  project_id: string | null
  started_at: string | null
  ended_at: string | null
  request: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  files: string[]
  task_refs: string[]
  tool_calls: number | null
  scheduled: boolean
  created_at: string
  updated_at: string
}

/**
 * Live or retired: a session recorded from a checkout still mapped to AC
 * belongs to the project AC became, not to no project at all (CAIRN-264).
 */
const projectIdForKey = async (_userId: string, key?: string | null): Promise<string | null> => {
  if (!key) return null
  return (await resolveProject(key))?.project.id ?? null
}

/**
 * The same order `cairn context` uses: the caller's key, then the remote, then
 * the directory.
 *
 * This used to be the key alone, and nothing sent one — the hook never passed
 * `--project` and `cairn session end` never looked it up — so 389 of 389 live
 * sessions landed with no project, `session list --project` was empty and the
 * briefing's "last session here" never answered (CAIRN-286). Current CLIs
 * resolve it themselves; this covers the ones already installed, and a sweep
 * whose checkout has no map entry.
 */
const projectIdForSession = async (
  userId: string,
  input: Pick<SessionUpsert, 'project' | 'repo' | 'cwd'>,
): Promise<string | null> => {
  const explicit = await projectIdForKey(userId, input.project)
  if (explicit) return explicit
  // Inference, so a failed lookup costs the attribution and never the row.
  try {
    const key =
      (input.repo ? await projectForRepo(userId, input.repo) : null) ??
      (input.cwd ? await projectForCwd(userId, input.cwd) : null) ??
      (input.cwd ? await projectForCheckoutName(userId, input.cwd) : null)
    return await projectIdForKey(userId, key)
  } catch {
    return null
  }
}

/**
 * Checkpoints what this session held, using the session summary.
 *
 * This is the discipline mechanism, and the reason it lives on the server
 * rather than in the hook: whatever the agent did or did not bother to record,
 * a claim it walked away from still says where it was left. It never *closes*
 * anything — closing needs a resolution somebody meant — and it never
 * *releases* anything either; that is reconcile's job, once a claim goes quiet.
 */
const RECORDED = AUTO_CHECKPOINT_MARKER

/**
 * The subset a given session may write a checkpoint onto.
 *
 * Pure and exported beside splitHeldByWorked, because this is the other half
 * of the same silent failure: a wrong checkpoint reads exactly like a right
 * one, and `cairn context` hands it to the next agent as fact.
 *
 * A task whose claim names no session is kept. It was claimed before the
 * column existed, or by a runtime that cannot name itself, and dropping those
 * would quietly stop checkpointing work that is genuinely held — trading a
 * silent bug for a silent regression. What keeps that safe is planAutoCheckpoints:
 * a claim this session cannot prove is its own is only ever written where
 * there is nothing a person or an agent wrote to lose.
 */
export const heldByThisSession = <T extends { claimed_session: string | null }>(
  held: T[],
  sessionId: string | null,
): T[] =>
  sessionId ? held.filter((t) => t.claimed_session === null || t.claimed_session === sessionId) : held

/**
 * Which held tasks this session actually worked, and which it merely held.
 *
 * Pure, and exported, because the distinction is the whole point of the fix and
 * the failure it prevents is silent: a wrong checkpoint reads exactly like a
 * right one.
 */
export const splitHeldByWorked = <T>(
  held: T[],
  taskRefs: string[],
  refOf: (task: T) => string,
): { touched: T[]; untouched: T[] } => {
  const worked = new Set(taskRefs)
  return {
    touched: held.filter((t) => worked.has(refOf(t))),
    untouched: held.filter((t) => !worked.has(refOf(t))),
  }
}

/** What a task the session actually advanced gets told. */
export const workedCheckpoint = (summary: string) => `${summary}\n\n${RECORDED}`

/**
 * What a task that was only held gets told: the true thing, plus where the
 * session's attention actually went, so the reader can judge whether the claim
 * is still meant. It deliberately does not repeat the summary — that summary is
 * about other work, and repeating it here is the bug this replaces.
 */
export const untouchedCheckpoint = (taskRefs: string[]) => {
  const elsewhere = taskRefs.slice(0, 5).join(', ')
  return (
    `${UNTOUCHED_CHECKPOINT_PREFIX}: the session that held this claim worked` +
    (elsewhere ? ` on ${elsewhere}` : ' elsewhere') +
    `.\n\n${RECORDED}`
  )
}

export type HeldForCheckpoint = {
  id: string
  number: number
  claimed_session: string | null
  checkpoint_summary: string | null
  project: { key: string }
}

/**
 * What the session-end checkpoint writes, and onto which tasks.
 *
 * Pure, because every rule in it exists to stop a loss that nothing reports.
 * On 2026-09-25 71 tasks carried "Still held, not progressed…" and 28 of them
 * had had a real checkpoint before it: BB-385's handoff — the one thing that
 * said which guard suite was green and what was uncommitted — was replaced
 * with a line about a different session's work (CAIRN-283).
 *
 * - A claim naming another session is never touched.
 * - A task this session did not work gets the "held, not progressed" line only
 *   where there is no checkpoint at all. Over an automatic one it adds
 *   nothing true; over a written one it destroys the handoff.
 * - A task it did work gets the summary. Over a written checkpoint only when
 *   the claim provably belongs to this session: a claim with no session named
 *   may be another session's, and a ref in the transcript is not proof of
 *   work — reading a task mentions it too.
 * - Rewriting identical text is skipped, so a sweep that re-records a session
 *   is a no-op rather than a fresh timestamp.
 */
export const planAutoCheckpoints = <T extends HeldForCheckpoint>(
  held: T[],
  { sessionId, taskRefs, summary }: { sessionId: string | null; taskRefs: string[]; summary: string },
): { task: T; text: string; worked: boolean }[] => {
  const refOf = (t: T) => `${t.project.key}-${t.number}`
  const { touched, untouched } = splitHeldByWorked(heldByThisSession(held, sessionId), taskRefs, refOf)
  const mine = (t: T) => sessionId !== null && t.claimed_session === sessionId
  const written = (t: T) => Boolean(t.checkpoint_summary) && !isAutoCheckpoint(t.checkpoint_summary)

  return [
    ...touched
      .filter((t) => mine(t) || !written(t))
      .map((task) => ({ task, text: workedCheckpoint(summary), worked: true })),
    ...untouched
      .filter((t) => !t.checkpoint_summary)
      .map((task) => ({ task, text: untouchedCheckpoint(taskRefs), worked: false })),
  ].filter(({ task, text }) => task.checkpoint_summary !== text)
}

const checkpointHeldTasks = async (actor: Actor, session: SessionRow): Promise<string[]> => {
  if (!actor.actorId) return []

  const { data, error } = await admin()
    .from('tasks')
    .select(
      'id, number, claimed_session, checkpoint_summary, ownership_version, checkpoint_version, ' +
        'project:projects!project_id!inner(key)',
    )
    .eq('claimed_by', actor.actorId)
  if (error) throw new Error(error.message)

  /**
   * Held by THIS session, not by everything wearing the same name.
   *
   * `claimed_by` is an actorLabel, so four Claude Code sessions on one machine
   * all match it. This used to write one session's checkpoint onto another
   * session's tasks: three knowledge-map tasks carried a report about merging
   * an unrelated pull request, because the identity matched and nothing else
   * was consulted. CAIRN-182 fixed the version of this that stamped tasks the
   * session never touched; the same wrong summary arrives here through
   * identity instead of through the file list.
   */
  const held = (data ?? []) as unknown as (HeldForCheckpoint & {
    ownership_version: number
    checkpoint_version: number
  })[]
  if (held.length === 0) return []

  const summary = [session.completed, session.next_steps && `Next: ${session.next_steps}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4_000)

  if (!summary) return []

  const at = session.ended_at ?? new Date().toISOString()
  const plan = planAutoCheckpoints(held, { sessionId: actor.sessionId, taskRefs: session.task_refs ?? [], summary })

  /**
   * One guarded write per task, and none of them is a sign of life.
   *
   * auto_checkpoint_task_atomic lands only if the claim, its generation and
   * the checkpoint this plan read are all unchanged, so a deliberate
   * checkpoint written in between wins. It leaves updated_at alone: the
   * reaper reads updated_at as activity, and a session-end hook recording
   * that a claim exists kept week-old claims alive on every runtime that
   * records sessions often.
   */
  const written: string[] = []
  for (const { task, text, worked } of plan) {
    const { data: ok, error: writeError } = await admin().rpc<boolean>('auto_checkpoint_task_atomic', {
      p_task_id: task.id,
      p_owner_user_id: actor.userId,
      p_actor_type: actor.actorType,
      p_actor_id: actor.actorId,
      p_expected_version: task.ownership_version,
      p_expected_checkpoint_version: task.checkpoint_version,
      p_expected_summary: task.checkpoint_summary,
      p_summary: text,
      p_at: at,
      p_data: { worked, session: session.external_id, platform: session.platform_source },
    })
    if (writeError) throw new Error(writeError.message)
    if (ok) written.push(`${task.project.key}-${task.number}`)
  }

  return written
}

/**
 * Keeps only refs whose project actually exists in the workspace.
 *
 * A transcript is scraped with a regex, and `[A-Z][A-Z0-9]+-\d+` matches
 * `SHA-256`, `HTTP-01`, `UTF-8` and the `Z0-9` out of a character class as
 * happily as it matches `CAIRN-64`. Filtering at the source would need a
 * blocklist that is wrong the moment someone names a project ISO; the
 * workspace project keys are the only authority that stays right.
 */
const keepRealRefs = async (_userId: string, refs: string[]): Promise<string[]> => {
  if (refs.length === 0) return []

  const { data, error } = await admin()
    .from('projects')
    .select('key')
  if (error) throw new Error(error.message)

  const keys = new Set((data ?? []).map((p) => (p.key as string).toUpperCase()))
  const kept = refs.filter((ref) => keys.has(ref.split('-')[0]?.toUpperCase() ?? ''))
  return [...new Set(kept)].slice(0, 100)
}

export const upsertSession = async (actor: Actor, input: SessionUpsert) => {
  const projectId = await projectIdForSession(actor.userId, input)
  const taskRefs = await keepRealRefs(actor.userId, input.taskRefs)

  const row = {
    owner_user_id: actor.userId,
    external_id: input.externalId,
    platform_source: input.platformSource,
    // Hooks may report the runtime name, but the authenticated key owns the
    // identity. Qualify caller-supplied names just like every other durable
    // attribution so two users running `codex` stay distinguishable.
    agent_id: input.agentId
      ? actorLabel('agent', input.agentId, actor.userDisplayName)
      : actor.actorId,
    cwd: input.cwd ?? null,
    project_id: projectId,
    started_at: input.startedAt ?? null,
    ended_at: input.ongoing ? null : (input.endedAt ?? new Date().toISOString()),
    request: input.request ?? null,
    learned: input.learned ?? null,
    completed: input.completed ?? null,
    next_steps: input.nextSteps ?? null,
    files: input.files,
    task_refs: taskRefs,
    tool_calls: input.toolCalls ?? null,
    scheduled: input.scheduled ?? false,
  }

  const { data, error } = await admin()
    .from('sessions')
    .upsert(row, { onConflict: 'platform_source,external_id' })
    .select(COLUMNS)
    .single<SessionRow>()

  // Preserve the database guard's SQLSTATE so the route can return 409 rather
  // than classifying a late checkpoint as malformed input.
  if (error) throw Object.assign(new Error(error.message), { code: error.code })

  await recordFiles(actor.userId, {
    paths: input.files,
    sessionId: data.id,
    projectId,
  })

  const checkpointed = !input.ongoing && input.checkpointHeld ? await checkpointHeldTasks(actor, data) : []

  return { session: data, checkpointed }
}

/** A total-order cursor; NULL (ongoing) rows precede ended rows. */
export const sessionCursor = (row: Pick<SessionRow, 'ended_at' | 'id' | 'cursor_ended_at'>): string =>
  Buffer.from(JSON.stringify([row.cursor_ended_at ?? row.ended_at, row.id])).toString('base64url')

const parseSessionCursor = (value: string): { endedAt: string | null; id: string } => {
  // Links issued before keyset pagination carried only the end timestamp.
  // The zero UUID preserves their old strictly-before behavior.
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    return { endedAt: value, id: '00000000-0000-0000-0000-000000000000' }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid session cursor')
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 ||
    !(decoded[0] === null || (typeof decoded[0] === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(decoded[0]))) ||
    typeof decoded[1] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded[1])) {
    throw new Error('Invalid session cursor')
  }
  return { endedAt: decoded[0], id: decoded[1] }
}

export const listSessions = async (
  _userId: string,
  filters: {
    project?: string
    cwd?: string
    agent?: string
    limit: number
    /** Keyset cursor for the timeline: rows strictly older than this. */
    before?: string
  },
): Promise<SessionRow[]> => {
  const clauses: string[] = []
  const values: unknown[] = []
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  if (filters.cwd) clauses.push(`cwd = ${bind(filters.cwd)}`)
  if (filters.agent) clauses.push(`agent_id = ${bind(filters.agent)}`)
  if (filters.project) {
    const projectId = await projectIdForKey(_userId, filters.project)
    if (!projectId) return []
    clauses.push(`project_id = ${bind(projectId)}`)
  }
  if (filters.before) {
    const cursor = parseSessionCursor(filters.before)
    if (cursor.endedAt === null) {
      // All remaining live rows, then the entire ended portion of the timeline.
      clauses.push(`((ended_at is null and id < ${bind(cursor.id)}) or ended_at is not null)`)
    } else {
      const ended = bind(cursor.endedAt)
      const id = bind(cursor.id)
      clauses.push(`(ended_at < ${ended} or (ended_at = ${ended} and id < ${id}))`)
    }
  }

  const where = clauses.length ? ` where ${clauses.join(' and ')}` : ''
  const { rows } = await pool().query<SessionRow>(
    `select ${COLUMNS}, to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ended_at
     from sessions${where} order by ended_at desc nulls first, id desc limit ${bind(filters.limit)}`,
    values,
  )
  return normalizeDatabaseValue(rows) as SessionRow[]
}

/** Distinct agent ids seen, for the sessions timeline's filter. */
export const listSessionAgents = async (_userId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('sessions')
    .select('agent_id')
    .not('agent_id', 'is', null)
  if (error) throw new Error(error.message)

  return [...new Set((data ?? []).map((r) => r.agent_id as string))].sort()
}

/** Project keys for the ids on a page of sessions, so the timeline can show one. */
export const projectKeysById = async (
  _userId: string,
  ids: string[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return out

  const { data, error } = await admin()
    .from('projects')
    .select('id, key')
    .in('id', wanted)
  if (error) throw new Error(error.message)

  for (const row of data ?? []) out.set(row.id as string, row.key as string)
  return out
}
