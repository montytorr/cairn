import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { issuedUnderFormerKey, lookupFormerKey, renameDay, type KeyRename } from './project-keys'
import { fail } from './response'

/**
 * Columns returned by `show`. Kept explicit so responses stay predictable.
 *
 * The embed carries `status` alongside `key`/`title` so every route that
 * resolves a task through this projection already has what `refuseArchived`
 * needs, with no second query.
 */
export const TASK_FIELDS =
  'id, project_id, number, title, description, type, status, priority, labels, due_date, position, ' +
  'actor_type, actor_id, assignee_user_id, claimed_by, claimed_session, claimed_at, heartbeat_at, attempt, ownership_version, ' +
  'checkpoint_summary, checkpoint_payload, checkpoint_at, checkpoint_version, blocked_reason, blocked_at, ' +
  'resolution, resolution_kind, resolved_at, resolved_by, duplicate_of, parent_id, external_ref, external_url, ' +
  'memory_session_id, observation_ids, created_at, updated_at, ' +
  // The Lab and hand-off (docs/lab.md). Shaped into `subject` and `handoff`
  // by withLabFields before any response; the raw columns never leave.
  'subject_id, handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at, ' +
  'project:projects!project_id!inner(id, key, title, status)'

/** Terse columns for list/search output. See the CLI's output discipline. */
export const TASK_LIST_FIELDS =
  'id, number, title, type, status, priority, labels, assignee_user_id, claimed_by, claimed_session, claimed_at, heartbeat_at, attempt, ownership_version, checkpoint_version, ' +
  // project_id as well as the embed: an activity row records the project by id,
  // and it is the only scope that survives the task being deleted.
  'resolution, external_ref, updated_at, project_id, ' +
  'subject_id, handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at, ' +
  'project:projects!project_id!inner(key, status)'

export type TaskRef = { key: string; number: number } | { id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A ref as the URL carried it. Not valid percent-encoding (`100%`) is taken as
 * written: it then matches no ref, which is a 404, never a thrown URIError.
 */
const decodeRef = (raw: string) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Accepts either `CAI-42` or a raw UUID, so both prose refs and ids work. */
export const parseRef = (raw: string): TaskRef | null => {
  const value = decodeRef(raw).trim()
  if (UUID.test(value)) return { id: value }

  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  return { key: match[1].toUpperCase(), number: Number(match[2]) }
}

export type TaskRow = Record<string, unknown> & { id: string }

/**
 * What a ref resolved to, and how.
 *
 * `renamed` is set when the ref's key is one the project used to have: the
 * task is the right one, and the caller is owed an explanation of why its ref
 * looks different (CAIRN-264). `neverIssued` is the other half of the same
 * rule — the key is retired, a task with that number exists under the live
 * key, but it was created after the rename, so the old ref never named it.
 */
export type ResolvedTask =
  | { task: TaskRow; renamed: KeyRename | null; requestedRef: string; neverIssued?: undefined }
  | { task: null; renamed: KeyRename | null; requestedRef: string; neverIssued?: string }

/** "HOL-113", from a row with either embedding of its project. */
export const refOfRow = (row: Record<string, unknown>) => {
  const embedded = (row.project ?? row.projects) as { key?: string } | { key?: string }[] | undefined
  const key = (Array.isArray(embedded) ? embedded[0] : embedded)?.key
  return key ? `${key}-${row.number as number}` : null
}

/**
 * Resolves a ref to a task in the shared workspace, saying whether it went
 * through a retired key.
 */
export const resolveTask = async (
  _actor: Actor,
  raw: string,
  fields = TASK_FIELDS,
): Promise<ResolvedTask> => {
  const requestedRef = decodeRef(raw).trim().toUpperCase()
  const ref = parseRef(raw)
  if (!ref) return { task: null, renamed: null, requestedRef }

  // Key-based refs need the embedded project relation even when callers request
  // a narrow projection. `status` rides along so `refuseArchived` works for
  // callers that asked for a narrow field set too.
  const select = fields.includes('projects!project_id!inner')
    ? fields
    : `${fields}, projects!project_id!inner(key, status)`

  const query = admin().from('tasks').select(select)

  const { data, error } =
    'id' in ref
      ? await query.eq('id', ref.id).maybeSingle()
      : await query.eq('number', ref.number).eq('projects.key', ref.key).maybeSingle()

  // A PostgREST error is NOT "no such task" — maybeSingle() reports zero rows
  // as data: null with no error. Swallowing it here is how adding a second
  // tasks->projects path (task_projects, file_touches) turned every lookup in
  // the product into "No task CAIRN-64." for a PGRST201 ambiguity that named
  // its own fix in the response body.
  if (error) throw new Error(`task lookup failed: ${error.message}`)
  if (data) return { task: data as unknown as TaskRow, renamed: null, requestedRef }

  // Not found under that key — but the key may be one the project used to
  // have. Refs escape into commit messages and other agents' notes, which a
  // rename cannot reach, so a retired key still resolves. Tried second rather
  // than first: a live key is never also a retired one, and the common path
  // should not pay for the rare one.
  if ('id' in ref) return { task: null, renamed: null, requestedRef }
  const former = await lookupFormerKey(ref.key)
  if (!former) return { task: null, renamed: null, requestedRef }

  // created_at decides whether the old ref was ever issued, so it is read even
  // when the caller asked for a narrower projection.
  const withCreated = /\bcreated_at\b/.test(select) ? select : `${select}, created_at`
  const { data: byFormer, error: formerError } = await admin()
    .from('tasks')
    .select(withCreated)
    .eq('project_id', former.projectId)
    .eq('number', ref.number)
    .maybeSingle()

  if (formerError) throw new Error(`task lookup failed: ${formerError.message}`)
  if (!byFormer) return { task: null, renamed: former.rename, requestedRef }

  const task = byFormer as unknown as TaskRow
  if (!issuedUnderFormerKey(former.rename, task.created_at)) {
    return {
      task: null,
      renamed: former.rename,
      requestedRef,
      neverIssued: refOfRow(task) ?? `${former.rename.to}-${ref.number}`,
    }
  }
  return { task, renamed: former.rename, requestedRef }
}

/**
 * Resolves a ref to a task in the shared workspace.
 *
 * The task alone, for the many callers that only act on it. Anything that
 * shows a task back to the caller should use `resolveTask` and pass the
 * rename on.
 */
export const findTask = async (actor: Actor, raw: string, fields = TASK_FIELDS) =>
  (await resolveTask(actor, raw, fields)).task

/** A task row's embedded project, whichever alias or shape fetched it. */
const embeddedProject = (row: Record<string, unknown>) => {
  const embedded = (row.project ?? row.projects) as
    | { key?: string; status?: string }
    | { key?: string; status?: string }[]
    | undefined
  return Array.isArray(embedded) ? embedded[0] : embedded
}

/**
 * Refuses a write to a task whose HOME project is archived (security review
 * F1).
 *
 * Archiving is what moving a project to another Cairn instance leaves behind
 * here: a frozen copy. Nothing stopped a CLI still routed to this instance by
 * a stale cache from closing, noting, or claiming a task in that copy — reads
 * worked, and so, silently, did every write. This is the one place that
 * refuses them, called right after a task is resolved and before anything
 * mutates.
 *
 * Reads stay allowed — the record should still be legible from either side —
 * only writes are refused.
 *
 * Only the task's HOME project (`project_id`) is checked. `task_projects`
 * rows only widen where a task is listed, not where it lives, so a task filed
 * at home in an active project but also linked into an archived one must
 * still be writable.
 *
 * Call this with the row `findTask`/`resolveTask` already returned — it reads
 * the embedded project rather than querying again, so it costs nothing extra
 * as long as the caller's field selection carries `project`/`projects` with
 * `status` (TASK_FIELDS and TASK_LIST_FIELDS both do; `resolveTask`'s
 * fallback embed for narrower field lists does too).
 */
export const refuseArchived = (task: TaskRow) => {
  const project = embeddedProject(task)
  if (!project || project.status !== 'archived') return null

  const key = project.key ?? 'its project'
  const number = task.number as number | undefined
  const ref = project.key && number !== undefined ? `${project.key}-${number}` : 'This task'

  return fail(
    'conflict',
    `${ref} lives in ${key}, which is archived — most likely because it moved to another Cairn ` +
      `instance and this is the copy left behind. If it moved, point the CLI at the other one ` +
      `with --instance <the other instance>. To write here instead, restore ${key} first: ` +
      `\`cairn project restore ${project.key ?? key}\`.`,
    { project: project.key ?? null, projectStatus: 'archived' },
  )
}

/**
 * What a response says about how a ref was reached. Empty for a current ref,
 * so nothing changes for the common case.
 */
export const renameFields = (resolved: Pick<ResolvedTask, 'renamed' | 'requestedRef'>) =>
  resolved.renamed
    ? { requested_ref: resolved.requestedRef, renamed_from: resolved.renamed }
    : {}

/** The 404 for a ref that did not resolve, naming the rename when there was one. */
export const noSuchTaskMessage = (raw: string, resolved: ResolvedTask) => {
  const { renamed, neverIssued } = resolved
  if (!renamed) return `No task ${raw}.`
  const day = renameDay(renamed.at)
  if (neverIssued) {
    return (
      `No task ${resolved.requestedRef}. Project ${renamed.key} was renamed ${renamed.to} on ${day}, ` +
      `and ${neverIssued} was created after that, so ${resolved.requestedRef} was never issued. ` +
      `Did you mean ${neverIssued}?`
    )
  }
  return `No task ${resolved.requestedRef}. Project ${renamed.key} was renamed ${renamed.to} on ${day}.`
}

/**
 * Resolves a would-be parent and refuses anything that would close a loop.
 *
 * The self-check lives in the database; a -> b -> a does not, because it needs
 * a walk. `task_is_descendant` does that walk in one round trip so the API and
 * the database cannot disagree about what a cycle is.
 */
export const resolveParent = async (
  actor: Actor,
  childId: string,
  raw: string,
): Promise<{ id: string } | { error: string }> => {
  const parent = await findTask(actor, raw, 'id, number, title')
  if (!parent) return { error: `No task ${raw}.` }
  if (parent.id === childId) return { error: 'A task cannot be its own parent.' }

  const { data, error } = await admin().rpc('task_is_descendant', {
    p_candidate: parent.id,
    p_ancestor: childId,
  })
  if (error) return { error: error.message }
  if (data === true) {
    return { error: `${raw} is already nested beneath this task — that would be a loop.` }
  }
  return { id: parent.id }
}
