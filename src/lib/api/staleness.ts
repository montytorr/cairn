import { admin } from '@/lib/db/client'
import { linkedFiles } from './knowledge'

/**
 * Facts do not stay true, and nothing about a stale one looks any different.
 *
 * Half a dozen entries describing the Supabase stack became wrong the day the
 * migration to native PostgreSQL landed, and they went on reading exactly like
 * a fact confirmed this morning. `verified_at` existed and nothing used it.
 *
 * Cairn already holds the evidence: `file_touches` maps paths to the sessions
 * and tasks that touched them, so for any fact that names files it can ask how
 * much has moved underneath it since it was last confirmed.
 *
 * Deliberately not expiry. A wrong confidence signal is worse than none, so
 * this marks and never hides, and a human or an agent decides.
 *
 * A fact that names no file has no such evidence, and 59% of the store names
 * none — the infra facts most of all (`clawdius-server` still described the
 * Supabase stack two weeks after it was removed). For those there is a second,
 * weaker mark: how long since anybody confirmed it. It is labelled apart from
 * `stale` on purpose. "Several sessions reworked the files under this" is
 * evidence; "nobody has looked in N days" is only a prompt to look, and must
 * never read as the first. Marked, not hidden, same as the other.
 */

/**
 * The files a fact is about, taken from the paths it names.
 *
 * Backticked paths are the convention in these entries and the one signal
 * precise enough to use: bare prose mentions "the client" and means a file
 * nobody can name. `knowledge_paths_in` in migration 060 restates this rule so
 * the database can keep `knowledge_files` from it; the knowledge-files
 * integration test holds the two to the same answers.
 */
export const filesNamedIn = (body: string): string[] => {
  const found = new Set<string>()
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const candidate = (match[1] ?? '').trim()
    // A path, not a snippet: a slash, no spaces, and a real extension. Without
    // the extension test `cairn check` and `owner/repo` both read as files.
    //
    // The leading ~ and / matter: the one real path in this store's own
    // knowledge is `~/.cairn/projects.json`, and an earlier version of this
    // regex rejected it — which would have made the whole feature inert while
    // looking like it worked.
    if (!/^(?:(?:~|\.\.?)?(?:\/[\w.@-]+)+|[\w.@-]+(?:\/[\w.@-]+)+)$/.test(candidate)) continue
    if (!/\.[a-z]{1,6}$/i.test(candidate)) continue
    found.add(candidate)
  }
  return [...found]
}

/**
 * Several separate sessions reworking the same files is the signal — one
 * session touching a file is just a session touching a file.
 */
export const STALE_SESSIONS = 2

/**
 * How long a fact with no files may go unconfirmed before it says so. Two
 * weeks, because what these entries describe — servers, stacks, containers,
 * who owns what — is exactly what changed under the Supabase entries inside
 * that time.
 */
export const UNVERIFIED_DAYS = 14

export type Staleness = {
  files: string[]
  touches: number
  sessions: number
  lastTouchedAt: string | null
  stale: boolean
  /**
   * Days since it was verified or written, set only when it names no file
   * and that is at least UNVERIFIED_DAYS. Not evidence of change: a prompt.
   */
  unverifiedDays: number | null
}

/** The age half, on its own so it can be tested without a database. */
export const unverifiedDaysFor = (
  entry: Pick<AgeableEntry, 'verified_at' | 'created_at'>,
  files: number,
  now = Date.now(),
): number | null => {
  if (files > 0) return null
  const reference = Date.parse(entry.verified_at ?? entry.created_at ?? '')
  if (Number.isNaN(reference)) return null
  const days = Math.floor((now - reference) / 86_400_000)
  return days >= UNVERIFIED_DAYS ? days : null
}

export type AgeableEntry = {
  id: string
  body: string
  verified_at?: string | null
  created_at?: string | null
  /** The work this fact came out of, whose files it is implicitly about. */
  source_task_id?: string | null
  source_session_id?: string | null
  /** The session as its runtime named it, for rows written before that session's row existed (064). */
  source_session_ref?: string | null
}

/**
 * The files the work behind a fact actually touched.
 *
 * Bodies here turn out to cite commands, tables and SQL functions far more
 * often than paths — `to_tsvector(regconfig, text)`, `git worktree`,
 * `project_repos` — so reading the prose alone would have left this marking
 * almost nothing. Where a fact records the task or session it came from, the
 * files that work touched are a better statement of what it is about than
 * anything it says about itself.
 */
const filesFromSource = async (
  _userId: string,
  entries: AgeableEntry[],
): Promise<Map<string, string[]>> => {
  const taskIds = entries.map((e) => e.source_task_id).filter(Boolean) as string[]
  const out = new Map<string, string[]>()

  // A fact learned mid-session names the session before its row exists, so
  // the ref is resolved here, at read time, once the session has ended.
  const refs = [
    ...new Set(
      entries.filter((e) => !e.source_session_id && e.source_session_ref).map((e) => e.source_session_ref as string),
    ),
  ]
  const resolved = new Map<string, string>()
  if (refs.length > 0) {
    const { data } = await admin().from('sessions').select('id, external_id').in('external_id', refs)
    for (const row of (data ?? []) as { id: string; external_id: string }[]) {
      if (!resolved.has(row.external_id)) resolved.set(row.external_id, row.id)
    }
  }
  const sessionOf = (e: AgeableEntry) =>
    e.source_session_id ?? (e.source_session_ref ? (resolved.get(e.source_session_ref) ?? null) : null)

  const sessionIds = entries.map(sessionOf).filter(Boolean) as string[]
  if (taskIds.length === 0 && sessionIds.length === 0) return out

  const byTask = new Map<string, string[]>()
  const bySession = new Map<string, string[]>()

  const collect = async (column: 'task_id' | 'session_id', ids: string[], into: Map<string, string[]>) => {
    if (ids.length === 0) return
    const { data } = await admin()
      .from('file_touches')
      .select(`path, ${column}`)
      .in(column, ids)
      .limit(2000)
    for (const row of (data ?? []) as Record<string, string>[]) {
      const key = row[column]
      if (!key || !row.path) continue
      into.set(key, [...(into.get(key) ?? []), row.path])
    }
  }

  await Promise.all([
    collect('task_id', taskIds, byTask),
    collect('session_id', sessionIds, bySession),
  ])

  for (const entry of entries) {
    const session = sessionOf(entry)
    const paths = [
      ...(entry.source_task_id ? (byTask.get(entry.source_task_id) ?? []) : []),
      ...(session ? (bySession.get(session) ?? []) : []),
    ]
    if (paths.length > 0) out.set(entry.id, [...new Set(paths)])
  }
  return out
}

/**
 * How much has moved under each fact since it was last confirmed.
 *
 * One query for every entry rather than one per entry: this runs inside search
 * and inside the briefing, both of which are already the slowest thing an
 * agent waits for.
 */
export const stalenessFor = async (
  userId: string,
  entries: AgeableEntry[],
): Promise<Map<string, Staleness>> => {
  const out = new Map<string, Staleness>()
  const byPath = new Map<string, AgeableEntry[]>()

  const [sourceFiles, linked] = await Promise.all([
    filesFromSource(userId, entries),
    linkedFiles(entries.map((e) => e.id)),
  ])

  for (const entry of entries) {
    const files = [
      ...new Set([
        ...filesNamedIn(entry.body ?? ''),
        ...(sourceFiles.get(entry.id) ?? []),
        // Stored links (CAIRN-269): the same two sources normalised, plus any
        // file named explicitly with `--files`.
        ...(linked.get(entry.id) ?? []),
      ]),
    ]
    out.set(entry.id, {
      files,
      touches: 0,
      sessions: 0,
      lastTouchedAt: null,
      stale: false,
      unverifiedDays: unverifiedDaysFor(entry, files.length),
    })
    for (const path of files) {
      byPath.set(path, [...(byPath.get(path) ?? []), entry])
    }
  }
  if (byPath.size === 0) return out

  // The oldest reference point across all of them bounds the query; each entry
  // is then filtered to its own, because they were confirmed at different times.
  const since = entries
    .map((e) => Date.parse(e.verified_at ?? e.created_at ?? ''))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)[0]

  const { data, error } = await admin()
    .from('file_touches')
    .select('path, session_id, created_at')
    .in('path', [...byPath.keys()])
    .gte('created_at', new Date(since ?? 0).toISOString())
    .limit(5000)

  if (error) throw new Error(`staleness lookup failed: ${error.message}`)

  const sessionsPer = new Map<string, Set<string>>()
  for (const touch of (data ?? []) as { path: string; session_id: string | null; created_at: string }[]) {
    const at = Date.parse(touch.created_at)
    for (const entry of byPath.get(touch.path) ?? []) {
      const reference = Date.parse(entry.verified_at ?? entry.created_at ?? '')
      if (!Number.isNaN(reference) && at <= reference) continue
      const current = out.get(entry.id)
      if (!current) continue
      current.touches += 1
      if (!current.lastTouchedAt || touch.created_at > current.lastTouchedAt) {
        current.lastTouchedAt = touch.created_at
      }
      const seen = sessionsPer.get(entry.id) ?? new Set<string>()
      // A touch with no session still counts as movement, just not as a second
      // opinion — otherwise one unattributed import could mark everything stale.
      if (touch.session_id) seen.add(touch.session_id)
      sessionsPer.set(entry.id, seen)
    }
  }

  for (const [id, value] of out) {
    value.sessions = sessionsPer.get(id)?.size ?? 0
    value.stale = value.sessions >= STALE_SESSIONS
  }
  return out
}
