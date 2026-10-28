import { normalizeDatabaseValue, pool } from '@/lib/db/client'

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
 * The key matches the source project's live key or a retired one, so an alias
 * still works after its source project was renamed. One query: callers reach
 * this only after the live and retired-key lookups missed, because a live ref
 * always wins.
 */
export const lookupMovedRef = async (
  key: string,
  number: number,
): Promise<{ taskId: string; move: Omit<TaskMove, 'to'> } | null> => {
  const upper = key.toUpperCase()
  const { rows } = await pool().query<{ task_id: string; moved_at: Date | string }>(
    `select r.task_id, r.moved_at
       from task_former_refs r
      where r.number = $2
        and r.project_id in (select id from projects where key = $1
                             union all
                             select project_id from project_former_keys where key = $1)
      limit 1`,
    [upper, number],
  )
  const row = rows[0]
  if (!row) return null
  return { taskId: row.task_id, move: { ref: `${upper}-${number}`, at: String(normalizeDatabaseValue(row.moved_at)) } }
}
