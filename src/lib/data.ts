import { admin } from '@/lib/supabase/admin'
import { serverClient } from '@/lib/supabase/server'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'

export type Task = {
  id: string
  number: number
  title: string
  description: string | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  due_date: string | null
  position: number
  actor_type: 'human' | 'agent'
  actor_id: string
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  checkpoint_summary: string | null
  checkpoint_at: string | null
  blocked_reason: string | null
  resolution: string | null
  resolution_kind: string | null
  resolved_at: string | null
  resolved_by: string | null
  external_ref: string | null
  external_url: string | null
  has_resolution: boolean
  duplicate_of: string | null
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  key: string
  title: string
  description: string | null
  status: string
  task_counter: number
}

/**
 * Every query here is scoped to the signed-in user explicitly, because the
 * service-role client bypasses RLS. RLS is the browser-side boundary and a
 * defence-in-depth layer; it is not what protects these reads.
 */
export const currentUser = async () => {
  const supabase = await serverClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

/**
 * Archived projects are excluded by default. Archiving exists so a finished
 * project can leave a 33-item sidebar without being destroyed, which only
 * works if the default view actually drops it.
 */
export const listProjects = async (
  userId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Project[]> => {
  const query = admin()
    .from('projects')
    .select('id, key, title, description, status, task_counter')
    .eq('owner_user_id', userId)
  const { data } = await (includeArchived ? query : query.eq('status', 'active'))
    .order('position')
    .order('created_at')
  return (data ?? []) as Project[]
}

export const getProject = async (userId: string, key: string): Promise<Project | null> => {
  const { data } = await admin()
    .from('projects')
    .select('id, key, title, description, status, task_counter')
    .eq('owner_user_id', userId)
    .eq('key', key.toUpperCase())
    .maybeSingle()
  return (data as Project) ?? null
}

/**
 * Columns the board and list actually render. Deliberately NOT `select *`:
 * one imported project holds 691 tasks and 1.9MB of markdown descriptions,
 * and shipping all of that to the browser to render two clamped preview lines
 * is the difference between a snappy page and a multi-second one.
 *
 * `preview` is truncated server-side; the full body is only fetched on the
 * task detail page, where it is actually shown.
 */
const LIST_COLUMNS =
  'id, number, title, type, status, priority, labels, due_date, position, ' +
  'claimed_by, heartbeat_at, blocked_reason, external_ref, updated_at, ' +
  'resolution_kind, has_resolution, checkpoint_summary, preview:description'

export type TaskListItem = Pick<
  Task,
  | 'id' | 'number' | 'title' | 'type' | 'status' | 'priority' | 'labels'
  | 'due_date' | 'position' | 'claimed_by' | 'heartbeat_at' | 'blocked_reason'
  | 'updated_at'
> & {
  preview: string | null
  external_ref: string | null
  resolution_kind: string | null
  has_resolution: boolean
  checkpoint_summary: string | null
}

export type TaskPage = { tasks: TaskListItem[]; total: number; closedHidden: number }

const PREVIEW_CHARS = 280

/**
 * Closed tasks are excluded by default. After importing years of history, 94%
 * of tasks are done — rendering them all by default would bury the handful
 * that are actually open.
 */
export const listTasks = async (
  projectId: string,
  { includeClosed = false, limit = 300 }: { includeClosed?: boolean; limit?: number } = {},
): Promise<TaskPage> => {
  const closedFilter = ['done', 'cancelled']

  const [openRows, totals] = await Promise.all([
    (() => {
      let q = admin()
        .from('tasks')
        .select(LIST_COLUMNS)
        .eq('project_id', projectId)
      if (!includeClosed) q = q.not('status', 'in', `(${closedFilter.join(',')})`)
      return q.order('position').order('number', { ascending: false }).limit(limit)
    })(),
    admin()
      .from('tasks')
      .select('status', { count: 'exact', head: false })
      .eq('project_id', projectId),
  ])

  const all = (totals.data ?? []) as { status: string }[]
  const tasks = ((openRows.data ?? []) as unknown as TaskListItem[]).map((t) => ({
    ...t,
    preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
  }))

  return {
    tasks,
    total: all.length,
    closedHidden: includeClosed ? 0 : all.filter((t) => closedFilter.includes(t.status)).length,
  }
}

export const getTask = async (
  userId: string,
  key: string,
  number: number,
): Promise<(Task & { project: Project }) | null> => {
  const { data } = await admin()
    .from('tasks')
    .select('*, project:projects!inner(id, key, title, description, status, task_counter, owner_user_id)')
    .eq('projects.owner_user_id', userId)
    .eq('projects.key', key.toUpperCase())
    .eq('number', number)
    .maybeSingle()
  return (data as unknown as (Task & { project: Project })) ?? null
}

/**
 * The ref and title of whatever a task duplicates. Its own query rather than a
 * join on getTask: it is null for almost every task, and `select *` already
 * pulls more than the detail page needs.
 */
export const getDuplicateOf = async (
  taskId: string,
): Promise<{ ref: string; title: string; status: string } | null> => {
  const { data } = await admin()
    .from('tasks')
    .select('number, title, status, project:projects!inner(key)')
    .eq('id', taskId)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as {
    number: number
    title: string
    status: string
    project: { key: string } | { key: string }[]
  }
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  return { ref: `${project?.key}-${row.number}`, title: row.title, status: row.status }
}

export type ActivityEntry = {
  id: string
  event: string
  data: Record<string, unknown> | null
  actor_type: string
  actor_id: string
  created_at: string
}

/** The audit trail for one task, newest first. */
export const listActivity = async (taskId: string): Promise<ActivityEntry[]> => {
  const { data } = await admin()
    .from('task_activity_events')
    .select('id, event, data, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(200)
  return (data ?? []) as ActivityEntry[]
}

export type Note = {
  id: string
  kind: string
  note: string
  facts: string[] | null
  actor_type: string
  actor_id: string
  created_at: string
}

export const listNotes = async (taskId: string): Promise<Note[]> => {
  const { data } = await admin()
    .from('task_notes')
    .select('id, kind, note, facts, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
  return (data ?? []) as Note[]
}

export type Comment = {
  id: string
  content: string
  comment_type: string
  actor_type: string
  actor_id: string
  created_at: string
}

export const listComments = async (taskId: string): Promise<Comment[]> => {
  const { data } = await admin()
    .from('task_comments')
    .select('id, content, comment_type, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at')
  return (data ?? []) as Comment[]
}

export type Attachment = {
  id: string
  original_name: string
  mime_type: string
  size_bytes: number
  actor_id: string
  created_at: string
}

export const listAttachments = async (taskId: string): Promise<Attachment[]> => {
  const { data } = await admin()
    .from('task_attachments')
    .select('id, original_name, mime_type, size_bytes, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at')
  return (data ?? []) as Attachment[]
}


/**
 * Every task the user owns, across all projects.
 *
 * The single most-missed view: with 34 projects, "what is open anywhere?"
 * cannot be answered by visiting each one. Same lightweight projection as the
 * per-project list — no descriptions — plus the project key, which is the
 * column that only matters when the list spans projects.
 */
export const listAllTasks = async (
  userId: string,
  {
    includeClosed = false,
    limit = 500,
  }: { includeClosed?: boolean; limit?: number } = {},
): Promise<{ tasks: (TaskListItem & { project_key: string })[]; closedHidden: number }> => {
  const closed = ['done', 'cancelled']

  let q = admin()
    .from('tasks')
    .select(`${LIST_COLUMNS}, project:projects!inner(key, owner_user_id)`)
    .eq('projects.owner_user_id', userId)

  if (!includeClosed) q = q.not('status', 'in', `(${closed.join(',')})`)

  const [rows, totals] = await Promise.all([
    q.order('updated_at', { ascending: false }).limit(limit),
    admin()
      .from('tasks')
      .select('id, project:projects!inner(owner_user_id)', { count: 'exact', head: true })
      .eq('projects.owner_user_id', userId)
      .in('status', closed),
  ])

  type Row = TaskListItem & { project: { key: string } | { key: string }[] }
  const tasks = ((rows.data ?? []) as unknown as Row[]).map((t) => ({
    ...t,
    preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
    project_key: (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? '',
  }))

  return { tasks, closedHidden: includeClosed ? 0 : (totals.count ?? 0) }
}


export type Relation = {
  id: string
  number: number
  title: string
  status: string
  project_key: string
  direction: 'blocked-by' | 'blocks'
}

/**
 * Task relationships, both directions.
 *
 * task_deps has been written by the API since the first migration and
 * rendered nowhere — so "this is waiting on that" existed in the data and was
 * invisible to the person deciding what to pick up.
 */
export const listRelations = async (taskId: string): Promise<Relation[]> => {
  const shape = 'blocked_id, blocking_id'
  const [blockedBy, blocks] = await Promise.all([
    admin().from('task_deps').select(shape).eq('blocked_id', taskId),
    admin().from('task_deps').select(shape).eq('blocking_id', taskId),
  ])

  const ids = [
    ...((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => ({
      id: r.blocking_id,
      direction: 'blocked-by' as const,
    })),
    ...((blocks.data ?? []) as { blocked_id: string }[]).map((r) => ({
      id: r.blocked_id,
      direction: 'blocks' as const,
    })),
  ]
  if (ids.length === 0) return []

  const { data } = await admin()
    .from('tasks')
    .select('id, number, title, status, project:projects!inner(key)')
    .in('id', ids.map((i) => i.id))

  type Row = { id: string; number: number; title: string; status: string; project: { key: string } | { key: string }[] }
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    project_key: (Array.isArray(row.project) ? row.project[0]?.key : row.project?.key) ?? '',
    direction: ids.find((i) => i.id === row.id)?.direction ?? 'blocked-by',
  }))
}
