import { admin } from '@/lib/db/client'
import { byTitle } from '@/lib/utils'
import { withAssignees, type Person } from '@/lib/api/people'
import { withHierarchy, type Hierarchy } from '@/lib/task-hierarchy'
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
  assignee_user_id: string
  /** Named live off `assignee_user_id`, not stored — see `withAssignees`. */
  assignee: Person | null
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
  parent_id: string | null
} & Partial<Hierarchy>

export type BoardProject = { id: string; key: string; title: string }

const BOARD_COLUMNS =
  'id, number, title, type, status, priority, labels, due_date, position, parent_id, ' +
  'assignee_user_id, claimed_by, heartbeat_at, blocked_reason, external_ref, updated_at, ' +
  'resolution_kind, has_resolution, checkpoint_summary, preview:description'

const PREVIEW_CHARS = 280

/**
 * Every task across every active project in the shared workspace, plus the project
 * list itself (columns and filters need it even for projects with nothing
 * currently showing). Closed tasks are excluded by default, same convention
 * as the per-project board.
 */
export const listBoardTasks = async (
  _userId: string,
  { includeClosed = false, limit = 2000 }: { includeClosed?: boolean; limit?: number } = {},
): Promise<{ tasks: BoardTask[]; projects: BoardProject[]; closedHidden: number }> => {
  const closed = ['done', 'cancelled']

  const [projectsRes, tasksRes, totals, links] = await Promise.all([
    admin()
      .from('projects')
      .select('id, key, title')
      .eq('status', 'active')
      .order('title')
      .order('created_at'),
    (() => {
      let q = admin()
        .from('tasks')
        .select(`${BOARD_COLUMNS}, project:projects!project_id!inner(key)`)
      if (!includeClosed) q = q.not('status', 'in', `(${closed.join(',')})`)
      return q.order('updated_at', { ascending: false }).limit(limit)
    })(),
    admin()
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .in('status', closed),
    admin().from('task_projects').select('task_id, project:projects(key)'),
  ])

  type Row = Omit<BoardTask, 'project_key' | 'assignee'> & { project: { key: string } | { key: string }[] }

  // Link rows are workspace-wide, just like the tasks and projects above.
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

  const tasks = await withAssignees(
    ((tasksRes.data ?? []) as unknown as Row[]).map((t) => {
      const home = (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? ''
      return {
        ...t,
        preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
        project_key: home,
        project_keys: [home, ...(guestKeys.get(t.id) ?? [])].filter(Boolean),
      }
    }),
  ).then(withHierarchy)

  return {
    tasks,
    projects: ((projectsRes.data ?? []) as BoardProject[]).sort(byTitle),
    closedHidden: includeClosed ? 0 : (totals.count ?? 0),
  }
}
