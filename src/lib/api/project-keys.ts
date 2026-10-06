import { admin } from '@/lib/db/client'
import { localDay } from '@/lib/dates'

/**
 * What a project used to be called.
 *
 * A ref is not an internal handle — it is designed to escape into commit
 * messages, PR titles and other agents' notes, all of which are immutable. A
 * rename cannot reach them, so the former key is kept and keeps resolving.
 *
 * Resolving is half of it. The other half is SAYING so (CAIRN-264): AC was
 * renamed HOL, `cairn show AC-113` returned HOL-113 with no explanation, and
 * `cairn next --project AC` answered "nothing open" for a project with open
 * work. An agent holding the old key could not tell it had reached the same
 * thing, or that it had reached nothing because of a rename. So every lookup
 * that goes through a retired key returns a `KeyRename` beside its answer,
 * and every surface that received one passes it on.
 */

/** A lookup that matched a retired key, and what that key is now. */
export type KeyRename = {
  /** The retired key the caller used. */
  key: string
  /** The project's live key — what to use from now on. */
  to: string
  /** When `key` was retired. */
  at: string
  /** Who retired it, where recorded (renames from before 057 have none). */
  by: string | null
}

/** One retired key of a project, as listed on the project. */
export type FormerKey = {
  key: string
  retired_at: string
  retired_by: string | null
  /** What `key` was renamed TO at the time — not necessarily the live key. */
  new_key: string | null
}

type FormerRow = {
  key: string
  project_id: string
  retired_at: string
  retired_by?: string | null
  project: { key: string } | { key: string }[] | null
}

const embeddedKey = (project: FormerRow['project']) =>
  (Array.isArray(project) ? project[0]?.key : project?.key) ?? ''

/**
 * The retired key's row, with the live key it now resolves to.
 *
 * Two plain reads rather than an embed: this is the rare path, and keeping it
 * free of relationship lookups keeps every caller testable without a schema.
 */
export const lookupFormerKey = async (
  key: string,
): Promise<{ projectId: string; rename: KeyRename } | null> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key, project_id, retired_at, retired_by')
    .eq('key', key.toUpperCase())
    .maybeSingle()

  if (error) throw new Error(error.message)
  const row = data as unknown as Omit<FormerRow, 'project'> | null
  if (!row?.project_id) return null

  const { data: live, error: liveError } = await admin()
    .from('projects')
    .select('key')
    .eq('id', row.project_id)
    .maybeSingle()
  if (liveError) throw new Error(liveError.message)

  return {
    projectId: row.project_id,
    rename: {
      key: row.key,
      to: (live as { key?: string } | null)?.key ?? '',
      at: row.retired_at,
      by: row.retired_by ?? null,
    },
  }
}

/** The project a retired key belongs to, or null if the key was never used. */
export const projectIdForFormerKey = async (
  _userId: string,
  key: string,
): Promise<string | null> => (await lookupFormerKey(key))?.projectId ?? null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A project by uuid, live key, or a key it used to have.
 *
 * The one resolver for every route that takes a project in its path or a
 * `--project` filter, so no surface can again answer "No project AC" — or
 * worse, an empty list — for a project that was only renamed. The live key is
 * tried first: a live key is never also a retired one, and the common path
 * should not pay for the rare one.
 */
export const resolveProject = async <T extends { id: string; key: string }>(
  idOrKey: string,
  columns = 'id, key',
): Promise<{ project: T; renamed: KeyRename | null } | null> => {
  const q = admin().from('projects').select(columns)
  const isUuid = UUID.test(idOrKey)
  const { data, error } = isUuid
    ? await q.eq('id', idOrKey).maybeSingle()
    : await q.eq('key', idOrKey.toUpperCase()).maybeSingle()
  if (error) throw new Error(error.message)
  if (data) return { project: data as unknown as T, renamed: null }
  if (isUuid) return null

  const former = await lookupFormerKey(idOrKey)
  if (!former) return null

  const { data: live, error: liveError } = await admin()
    .from('projects')
    .select(columns)
    .eq('id', former.projectId)
    .maybeSingle()
  if (liveError) throw new Error(liveError.message)
  if (!live) return null
  const project = live as unknown as T
  return { project, renamed: { ...former.rename, to: project.key } }
}

/**
 * A `--project` filter, normalised to the live key.
 *
 * For the routes that filter by key rather than load the project. An unknown
 * key comes back unchanged with no rename, so each route keeps whatever it did
 * with an unknown key before; only a retired one is rewritten.
 */
export const liveProjectKey = async (
  raw: string | undefined | null,
): Promise<{ key: string | undefined; renamed: KeyRename | null }> => {
  if (!raw) return { key: undefined, renamed: null }
  const upper = raw.toUpperCase()
  const { data, error } = await admin().from('projects').select('key').eq('key', upper).maybeSingle()
  if (error) throw new Error(error.message)
  if (data) return { key: upper, renamed: null }

  const former = await lookupFormerKey(upper)
  if (!former?.rename.to) return { key: upper, renamed: null }
  return { key: former.rename.to, renamed: former.rename }
}

/** Every retired key, with the live key it now resolves to. */
export const listFormerKeys = async (
  _userId: string,
): Promise<{ key: string; project_id: string; current: string }[]> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key, project_id, project:projects(key)')
    .order('retired_at')

  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as FormerRow[]).map((row) => ({
    key: row.key,
    project_id: row.project_id,
    current: embeddedKey(row.project),
  }))
}

/** The keys a given project has been known by, oldest first. */
export const formerKeysFor = async (_userId: string, projectId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key')
    .eq('project_id', projectId)
    .order('retired_at')

  if (error) throw new Error(error.message)
  return ((data ?? []) as { key: string }[]).map((row) => row.key)
}

/**
 * Former keys for many projects in one query, grouped by project id, oldest
 * first — what `GET /projects` and `/projects/{key}` list as `former_keys`.
 */
export const formerKeysByProject = async (
  projectIds: string[],
): Promise<Map<string, FormerKey[]>> => {
  const out = new Map<string, FormerKey[]>()
  if (projectIds.length === 0) return out

  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key, project_id, retired_at, retired_by, new_key')
    .in('project_id', projectIds)
    .order('retired_at')

  if (error) throw new Error(error.message)
  for (const row of (data ?? []) as unknown as (FormerKey & { project_id: string })[]) {
    const list = out.get(row.project_id) ?? []
    list.push({
      key: row.key,
      retired_at: row.retired_at,
      retired_by: row.retired_by ?? null,
      new_key: row.new_key ?? null,
    })
    out.set(row.project_id, list)
  }
  return out
}

/**
 * The refs a task was actually issued under before its project was renamed.
 *
 * Only keys retired AFTER the task existed: HOL-114, filed the day after AC
 * became HOL, was never AC-114, and saying "(was AC-114)" invents a ref nobody
 * ever wrote down. The page used to say exactly that, because it listed every
 * former key against every task.
 */
export const formerRefsOf = (
  task: { number: number; created_at?: string | null },
  formerKeys: Pick<FormerKey, 'key' | 'retired_at'>[],
): string[] => {
  const created = task.created_at ? Date.parse(task.created_at) : Number.NaN
  return formerKeys
    .filter((former) => !Number.isFinite(created) || Date.parse(former.retired_at) > created)
    .map((former) => `${former.key}-${task.number}`)
}

/** Whether a ref through `rename.key` was ever issued for a task created at `createdAt`. */
export const issuedUnderFormerKey = (rename: Pick<KeyRename, 'at'>, createdAt: unknown) =>
  typeof createdAt !== 'string' || Date.parse(rename.at) > Date.parse(createdAt)

/** "2026-09-22" — a rename is a dated fact, and the time of day is noise. */
export const renameDay = (at: string) => localDay(at)

/**
 * Several project keys at once, live or retired, keyed by the spelling asked
 * for. Retired keys are looked up only for the ones the live query missed.
 */
export const projectsForKeys = async (
  keys: string[],
): Promise<{
  found: Map<string, { id: string; key: string }>
  missing: string[]
  renamed: KeyRename[]
}> => {
  const wanted = [...new Set(keys.map((key) => key.toUpperCase()))]
  const found = new Map<string, { id: string; key: string }>()
  const renamed: KeyRename[] = []
  if (wanted.length === 0) return { found, missing: [], renamed }

  const { data, error } = await admin().from('projects').select('id, key').in('key', wanted)
  if (error) throw new Error(error.message)
  for (const row of (data ?? []) as { id: string; key: string }[]) found.set(row.key, row)

  for (const key of wanted) {
    if (found.has(key)) continue
    const former = await lookupFormerKey(key)
    if (!former?.rename.to) continue
    found.set(key, { id: former.projectId, key: former.rename.to })
    renamed.push(former.rename)
  }

  return { found, missing: wanted.filter((key) => !found.has(key)), renamed }
}
