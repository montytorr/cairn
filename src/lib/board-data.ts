import { admin } from '@/lib/supabase/admin'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'

/**
 * Data loader for the cross-project board (`/board`, CAIRN-72).
 *
 * A deliberate standalone copy of the projection `listTasks`/`listAllTasks`
 * use in `src/lib/data.ts`, not an import from it: that file is being edited
 * concurrently, and a shape change made for the per-project views should not
 * silently ripple into this one (or vice versa).
 */

export type BoardTask = {
  id: string
  number: number
  title: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  due_date: string | null
  position: number
  claimed_by: string | null
  heartbeat_at: string | null
  blocked_reason: string | null
  updated_at: string
  preview: string | null
  external_ref: string | null
  resolution_kind: string | null
  has_resolution: boolean
  checkpoint_summary: string | null
  /** The project this task actually lives in — the whole point of this board. */
  project_key: string
  /**
   * Every project this task belongs to: its home first, then any secondary
   * links. Supra-project work is filed once and shown everywhere it applies,
   * so grouping by project must see all of them, not just the one that
   * happens to own the ref.
   */
  project_keys: string[]
}

export type BoardProject = { id: string; key: string; title: string }

const BOARD_COLUMNS =
  'id, number, title, type, status, priority, labels, due_date, position, ' +
  'claimed_by, heartbeat_at, blocked_reason, external_ref, updated_at, ' +
  'resolution_kind, has_resolution, checkpoint_summary, preview:description'

const PREVIEW_CHARS = 280

/**
 * Every task across every active project the user owns, plus the project
 * list itself (columns and filters need it even for projects with nothing
 * currently showing). Closed tasks are excluded by default, same convention
 * as the per-project board.
 */
export const listBoardTasks = async (
  userId: string,
  { includeClosed = false, limit = 2000 }: { includeClosed?: boolean; limit?: number } = {},
): Promise<{ tasks: BoardTask[]; projects: BoardProject[]; closedHidden: number }> => {
  const closed = ['done', 'cancelled']

  const [projectsRes, tasksRes, totals, links] = await Promise.all([
    admin()
      .from('projects')
      .select('id, key, title')
      .eq('owner_user_id', userId)
      .eq('status', 'active')
      .order('position')
      .order('created_at'),
    (() => {
      let q = admin()
        .from('tasks')
        .select(`${BOARD_COLUMNS}, project:projects!project_id!inner(key, owner_user_id)`)
        .eq('projects.owner_user_id', userId)
      if (!includeClosed) q = q.not('status', 'in', `(${closed.join(',')})`)
      return q.order('updated_at', { ascending: false }).limit(limit)
    })(),
    admin()
      .from('tasks')
      .select('id, project:projects!project_id!inner(owner_user_id)', { count: 'exact', head: true })
      .eq('projects.owner_user_id', userId)
      .in('status', closed),
    admin().from('task_projects').select('task_id, project:projects(key)'),
  ])

  type Row = Omit<BoardTask, 'project_key'> & { project: { key: string } | { key: string }[] }

  // RLS is bypassed by the service role, so the link rows are narrowed to the
  // tasks this query already established belong to this owner.
  const guestKeys = new Map<string, string[]>()
  for (const row of (links.data ?? []) as unknown as {
    task_id: string
    project: { key: string } | { key: string }[] | null
  }[]) {
    const embedded = row.project
    const key = Array.isArray(embedded) ? embedded[0]?.key : embedded?.key
    if (!key) continue
    guestKeys.set(row.task_id, [...(guestKeys.get(row.task_id) ?? []), key])
  }

  const tasks = ((tasksRes.data ?? []) as unknown as Row[]).map((t) => {
    const home = (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? ''
    return {
      ...t,
      preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
      project_key: home,
      project_keys: [home, ...(guestKeys.get(t.id) ?? [])].filter(Boolean),
    }
  })

  return {
    tasks,
    projects: (projectsRes.data ?? []) as BoardProject[],
    closedHidden: includeClosed ? 0 : (totals.count ?? 0),
  }
}
