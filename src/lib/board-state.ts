import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/schemas/task'
import type { BoardProject, BoardTask } from '@/lib/board-data'
import { ASSIGNEE_PARAM, parseAssignees, serializeAssignees } from '@/lib/assignee-filter'

/**
 * Pure grouping, filtering and URL-encoding logic for `/board` (CAIRN-72).
 *
 * Kept free of React so it can be unit tested directly, the same split
 * `applySelection` (src/lib/selection.ts) uses for the same reason.
 */

export const GROUP_BY_VALUES = ['status', 'priority', 'type', 'project', 'agent', 'assignee'] as const
export type GroupBy = (typeof GROUP_BY_VALUES)[number]

export const SWIMLANE_VALUES = ['none', 'project', 'priority', 'agent', 'assignee'] as const
export type Swimlane = (typeof SWIMLANE_VALUES)[number]

/**
 * Column/lane value standing in for "nobody holds this." Never a real agent
 * id. The value is persisted in shared board links, so it stays exactly as
 * it always has even though the label shown for it is now "Unclaimed" —
 * `claimed_by`, unlike `assignee_user_id`, is genuinely nullable.
 */
export const UNASSIGNED = '__unassigned__'

/** Joins a lane value and a column value into one droppable id. Chosen to be
 * vanishingly unlikely to appear inside a project key, agent name or label. */
export const SEP = '␟'

export type BoardFilters = {
  groupBy: GroupBy
  swimlane: Swimlane
  projects: string[]
  types: string[]
  priorities: string[]
  labels: string[]
  agents: string[]
  assignees: string[]
}

export const DEFAULT_FILTERS: BoardFilters = {
  groupBy: 'status',
  swimlane: 'none',
  projects: [],
  types: [],
  priorities: [],
  labels: [],
  agents: [],
  assignees: [],
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const listParam = (params: URLSearchParams, key: string): string[] => {
  const raw = params.get(key)
  return raw ? raw.split(',').filter(Boolean) : []
}

/** Reads the shareable-link query string into board state. Anything absent
 * or unrecognised falls back to the default rather than throwing — a stale
 * or hand-edited link should degrade gracefully, not break the page. */
/**
 * `me` is the viewer: with it, no `assignee` param means their own tasks, as
 * on every task list (CAIRN-339). Without it — the tests, a caller that does
 * not know who is looking — the param reads as it always has.
 */
export const parseFilters = (search: string, me = ''): BoardFilters => {
  const params = new URLSearchParams(search)
  const groupBy = params.get('groupBy') ?? ''
  const swimlane = params.get('swimlane') ?? ''
  return {
    groupBy: (GROUP_BY_VALUES as readonly string[]).includes(groupBy) ? (groupBy as GroupBy) : 'status',
    swimlane: (SWIMLANE_VALUES as readonly string[]).includes(swimlane) ? (swimlane as Swimlane) : 'none',
    projects: listParam(params, 'project'),
    types: listParam(params, 'type'),
    priorities: listParam(params, 'priority'),
    labels: listParam(params, 'label'),
    agents: listParam(params, 'agent'),
    assignees: me ? parseAssignees(params.get(ASSIGNEE_PARAM), me) : listParam(params, 'assignee'),
  }
}

/** The inverse of `parseFilters`, omitting anything at its default so a plain
 * `/board` link stays plain. */
export const serializeFilters = (filters: BoardFilters, me = ''): string => {
  const params = new URLSearchParams()
  if (filters.groupBy !== DEFAULT_FILTERS.groupBy) params.set('groupBy', filters.groupBy)
  if (filters.swimlane !== DEFAULT_FILTERS.swimlane) params.set('swimlane', filters.swimlane)
  if (filters.projects.length > 0) params.set('project', filters.projects.join(','))
  if (filters.types.length > 0) params.set('type', filters.types.join(','))
  if (filters.priorities.length > 0) params.set('priority', filters.priorities.join(','))
  if (filters.labels.length > 0) params.set('label', filters.labels.join(','))
  if (filters.agents.length > 0) params.set('agent', filters.agents.join(','))
  if (me) {
    const assignee = serializeAssignees(filters.assignees, me)
    if (assignee !== null) params.set(ASSIGNEE_PARAM, assignee)
  } else if (filters.assignees.length > 0) params.set('assignee', filters.assignees.join(','))
  return params.toString()
}

/**
 * The next URL for the address bar after a filter/group/swimlane change.
 *
 * `closed` is not part of `BoardFilters` — it is a server-loaded toggle, not a
 * client-side filter — so it is read out of the CURRENT query string and
 * carried over rather than dropped.
 */
export const buildBoardUrl = (pathname: string, filters: BoardFilters, currentSearch: string, me = ''): string => {
  const current = new URLSearchParams(currentSearch)
  const next = new URLSearchParams(serializeFilters(filters, me))
  const closed = current.get('closed')
  if (closed) next.set('closed', closed)
  const qs = next.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

export const matchesFilters = (task: BoardTask, filters: BoardFilters): boolean => {
  // Filtering by project matches every project the task belongs to, so a
  // supra-project task shows up under each of them. Grouping does not: a card
  // must sit in exactly one column or dragging it means two contradictory
  // things, so it stays in the project that owns its ref.
  if (
    filters.projects.length > 0 &&
    !(task.project_keys ?? [task.project_key]).some((k) => filters.projects.includes(k))
  ) {
    return false
  }
  if (filters.types.length > 0 && !filters.types.includes(task.type)) return false
  if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) return false
  if (filters.labels.length > 0 && !filters.labels.some((l) => task.labels.includes(l))) return false
  if (filters.agents.length > 0 && !filters.agents.includes(task.claimed_by ?? UNASSIGNED)) return false
  if (filters.assignees.length > 0 && !filters.assignees.includes(task.assignee_user_id)) return false
  return true
}

/** The task's current value along whichever dimension is grouping columns
 * (or swimlanes), so a drag target can be compared against where it already is. */
export const groupValue = (task: BoardTask, groupBy: GroupBy): string => {
  if (groupBy === 'status') return task.status
  if (groupBy === 'priority') return task.priority
  if (groupBy === 'type') return task.type
  if (groupBy === 'project') return task.project_key
  if (groupBy === 'assignee') return task.assignee_user_id
  return task.claimed_by ?? UNASSIGNED
}

/** Optimistic local update for a drag: sets whichever field the current
 * grouping represents. The server response (after `router.refresh()`)
 * reconciles anything this cannot know locally — a project move's renumbering,
 * chiefly. */
export const applyGroupValue = (task: BoardTask, groupBy: GroupBy, value: string): BoardTask => {
  if (groupBy === 'status') return { ...task, status: value as TaskStatus }
  if (groupBy === 'priority') return { ...task, priority: value as TaskPriority }
  if (groupBy === 'type') return { ...task, type: value as TaskType }
  if (groupBy === 'project') return { ...task, project_key: value }
  // The name shown on the card is `task.assignee.name`, not this id, and this
  // function has no people list to resolve it from — so the card keeps
  // showing the outgoing name until `router.refresh()` brings the real one.
  if (groupBy === 'assignee') return { ...task, assignee_user_id: value }
  return { ...task, claimed_by: value === UNASSIGNED ? null : value }
}

export type ColumnDef = { value: string; label: string }

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** Distinct assignees seen across a task set, named off the row's own
 * `assignee` embed rather than a separate people list — every task carries
 * one, so the set of columns/lanes needs nothing beyond what is already
 * loaded. */
const assigneesOf = (tasks: BoardTask[]): ColumnDef[] => {
  const names = new Map<string, string>()
  for (const t of tasks) names.set(t.assignee_user_id, t.assignee?.name ?? t.assignee_user_id)
  return [...names.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Columns are drop targets, so their set is deliberately stable regardless of
 * the active filters — computed from every loaded task, not the filtered
 * subset, so a filtered-out agent or project does not lose its column (and
 * therefore its ability to be dropped onto).
 */
export const columnsFor = (groupBy: GroupBy, tasks: BoardTask[], projects: BoardProject[]): ColumnDef[] => {
  if (groupBy === 'status') return TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))
  if (groupBy === 'priority') return TASK_PRIORITIES.map((p) => ({ value: p, label: capitalize(p) }))
  if (groupBy === 'type') return TASK_TYPES.map((t) => ({ value: t, label: capitalize(t) }))
  if (groupBy === 'project') return projects.map((p) => ({ value: p.key, label: p.title }))
  if (groupBy === 'assignee') return assigneesOf(tasks)

  const agents = [...new Set(tasks.map((t) => t.claimed_by).filter((a): a is string => Boolean(a)))].sort()
  return [{ value: UNASSIGNED, label: 'Unclaimed' }, ...agents.map((a) => ({ value: a, label: a }))]
}

/** The task's value along the swimlane dimension. Only meaningful lanes are
 * rendered, so — unlike `columnsFor` — this is fine to compute per-task from
 * whatever set the caller passes (the already-filtered, visible tasks). */
export const laneValueOf = (task: BoardTask, swimlane: Swimlane): string => {
  if (swimlane === 'none') return 'all'
  if (swimlane === 'project') return task.project_key
  if (swimlane === 'priority') return task.priority
  if (swimlane === 'assignee') return task.assignee_user_id
  return task.claimed_by ?? UNASSIGNED
}

/**
 * Swimlanes, unlike columns, are not drop targets — so only lanes that
 * actually have a visible task in them are shown. A lane with nothing in it
 * is clutter, not an opportunity.
 */
export const lanesFor = (swimlane: Swimlane, visible: BoardTask[], projects: BoardProject[]): ColumnDef[] => {
  if (swimlane === 'none') return [{ value: 'all', label: '' }]

  const present = new Set(visible.map((t) => laneValueOf(t, swimlane)))

  if (swimlane === 'project') {
    return projects.filter((p) => present.has(p.key)).map((p) => ({ value: p.key, label: p.title }))
  }
  if (swimlane === 'priority') {
    return TASK_PRIORITIES.filter((p) => present.has(p)).map((p) => ({ value: p, label: capitalize(p) }))
  }
  if (swimlane === 'assignee') return assigneesOf(visible)
  return [...present]
    .sort((a, b) => (a === UNASSIGNED ? -1 : b === UNASSIGNED ? 1 : a.localeCompare(b)))
    .map((a) => ({ value: a, label: a === UNASSIGNED ? 'Unclaimed' : a }))
}
