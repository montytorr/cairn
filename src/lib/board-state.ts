import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/schemas/task'
import type { BoardProject, BoardTask } from '@/lib/board-data'

/**
 * Pure grouping, filtering and URL-encoding logic for `/board` (CAIRN-72).
 *
 * Kept free of React so it can be unit tested directly, the same split
 * `applySelection` (src/lib/selection.ts) uses for the same reason.
 */

export const GROUP_BY_VALUES = ['status', 'priority', 'type', 'project', 'agent'] as const
export type GroupBy = (typeof GROUP_BY_VALUES)[number]

export const SWIMLANE_VALUES = ['none', 'project', 'priority', 'agent'] as const
export type Swimlane = (typeof SWIMLANE_VALUES)[number]

/** Column/lane value standing in for "nobody holds this." Never a real agent id. */
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
}

export const DEFAULT_FILTERS: BoardFilters = {
  groupBy: 'status',
  swimlane: 'none',
  projects: [],
  types: [],
  priorities: [],
  labels: [],
  agents: [],
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const listParam = (params: URLSearchParams, key: string): string[] => {
  const raw = params.get(key)
  return raw ? raw.split(',').filter(Boolean) : []
}

/** Reads the shareable-link query string into board state. Anything absent
 * or unrecognised falls back to the default rather than throwing — a stale
 * or hand-edited link should degrade gracefully, not break the page. */
export const parseFilters = (search: string): BoardFilters => {
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
  }
}

/** The inverse of `parseFilters`, omitting anything at its default so a plain
 * `/board` link stays plain. */
export const serializeFilters = (filters: BoardFilters): string => {
  const params = new URLSearchParams()
  if (filters.groupBy !== DEFAULT_FILTERS.groupBy) params.set('groupBy', filters.groupBy)
  if (filters.swimlane !== DEFAULT_FILTERS.swimlane) params.set('swimlane', filters.swimlane)
  if (filters.projects.length > 0) params.set('project', filters.projects.join(','))
  if (filters.types.length > 0) params.set('type', filters.types.join(','))
  if (filters.priorities.length > 0) params.set('priority', filters.priorities.join(','))
  if (filters.labels.length > 0) params.set('label', filters.labels.join(','))
  if (filters.agents.length > 0) params.set('agent', filters.agents.join(','))
  return params.toString()
}

/**
 * The next URL for the address bar after a filter/group/swimlane change.
 *
 * `closed` is not part of `BoardFilters` — it is a server-loaded toggle, not a
 * client-side filter — so it is read out of the CURRENT query string and
 * carried over rather than dropped.
 */
export const buildBoardUrl = (pathname: string, filters: BoardFilters, currentSearch: string): string => {
  const current = new URLSearchParams(currentSearch)
  const next = new URLSearchParams(serializeFilters(filters))
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
  return true
}

/** The task's current value along whichever dimension is grouping columns
 * (or swimlanes), so a drag target can be compared against where it already is. */
export const groupValue = (task: BoardTask, groupBy: GroupBy): string => {
  if (groupBy === 'status') return task.status
  if (groupBy === 'priority') return task.priority
  if (groupBy === 'type') return task.type
  if (groupBy === 'project') return task.project_key
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

  const agents = [...new Set(tasks.map((t) => t.claimed_by).filter((a): a is string => Boolean(a)))].sort()
  return [{ value: UNASSIGNED, label: 'Unassigned' }, ...agents.map((a) => ({ value: a, label: a }))]
}

/** The task's value along the swimlane dimension. Only meaningful lanes are
 * rendered, so — unlike `columnsFor` — this is fine to compute per-task from
 * whatever set the caller passes (the already-filtered, visible tasks). */
export const laneValueOf = (task: BoardTask, swimlane: Swimlane): string => {
  if (swimlane === 'none') return 'all'
  if (swimlane === 'project') return task.project_key
  if (swimlane === 'priority') return task.priority
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
  return [...present]
    .sort((a, b) => (a === UNASSIGNED ? -1 : b === UNASSIGNED ? 1 : a.localeCompare(b)))
    .map((a) => ({ value: a, label: a === UNASSIGNED ? 'Unassigned' : a }))
}
