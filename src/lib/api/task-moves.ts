import { admin } from '@/lib/db/client'
import { lookupFormerKey } from './project-keys'

/**
 * A ref a task was filed under before it moved to another project.
 *
 * Same reasoning as a retired project key: ABC-46 written into a commit
 * message cannot be rewritten when the task becomes XYZ-8, so it keeps
 * resolving, and the response says so.
 */
export type TaskMove = {
  /** The ref the caller used. */
  ref: string
  /** The task's live ref, where known. */
  to: string
  /** When the task left. */
  at: string
}

/**
 * The task a moved-away ref used to name, or null.
 *
 * The key is resolved to a project id first (live key, then a retired one), so
 * an alias still works after its source project was renamed. Callers try the
 * live task before this: a live ref always wins.
 */
export const lookupMovedRef = async (
  key: string,
  number: number,
): Promise<{ taskId: string; move: Omit<TaskMove, 'to'> } | null> => {
  const upper = key.toUpperCase()
  const { data: live, error: liveError } = await admin()
    .from('projects')
    .select('id')
    .eq('key', upper)
    .maybeSingle()
  if (liveError) throw new Error(liveError.message)

  const projectId = (live as { id?: string } | null)?.id ?? (await lookupFormerKey(upper))?.projectId
  if (!projectId) return null

  const { data, error } = await admin()
    .from('task_former_refs')
    .select('task_id, moved_at')
    .eq('project_id', projectId)
    .eq('number', number)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { task_id?: string; moved_at?: string } | null
  if (!row?.task_id) return null
  return { taskId: row.task_id, move: { ref: `${upper}-${number}`, at: row.moved_at ?? '' } }
}
