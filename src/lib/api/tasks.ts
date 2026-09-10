import { admin } from '@/lib/supabase/admin'
import type { Actor } from './auth'

/** Columns returned by `show`. Kept explicit so responses stay predictable. */
export const TASK_FIELDS =
  'id, number, title, description, type, status, priority, labels, due_date, position, ' +
  'actor_type, actor_id, claimed_by, claimed_at, heartbeat_at, attempt, ' +
  'checkpoint_summary, checkpoint_payload, checkpoint_at, blocked_reason, blocked_at, ' +
  'resolution, resolution_kind, resolved_at, resolved_by, duplicate_of, parent_id, ' +
  'memory_session_id, observation_ids, created_at, updated_at, ' +
  'project:projects!inner(id, key, title, owner_user_id)'

/** Terse columns for list/search output. See the CLI's output discipline. */
export const TASK_LIST_FIELDS =
  'id, number, title, type, status, priority, labels, claimed_by, heartbeat_at, ' +
  'resolution, updated_at, project:projects!inner(key, owner_user_id)'

export type TaskRef = { key: string; number: number } | { id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Accepts either `CAI-42` or a raw UUID, so both prose refs and ids work. */
export const parseRef = (raw: string): TaskRef | null => {
  const value = decodeURIComponent(raw).trim()
  if (UUID.test(value)) return { id: value }

  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  return { key: match[1].toUpperCase(), number: Number(match[2]) }
}

/**
 * Resolves a ref to a task, scoped to the actor's own projects.
 *
 * Every read goes through here precisely because the service-role client
 * bypasses RLS: the owner filter has to be applied explicitly, every time.
 */
export const findTask = async (actor: Actor, raw: string, fields = TASK_FIELDS) => {
  const ref = parseRef(raw)
  if (!ref) return null

  const query = admin().from('tasks').select(fields).eq('projects.owner_user_id', actor.userId)

  const { data, error } =
    'id' in ref
      ? await query.eq('id', ref.id).maybeSingle()
      : await query.eq('number', ref.number).eq('projects.key', ref.key).maybeSingle()

  if (error || !data) return null
  return data as unknown as Record<string, unknown> & { id: string }
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
