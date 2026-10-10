import { TASK_STATUSES, isTerminal, type TaskStatus } from '@/schemas/task'
import { handoffIsOpen, type Todo } from './types'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** A status the API might add later reads as `todo` rather than dropping a row. */
export const asStatus = (status: string): TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(status) ? (status as TaskStatus) : 'todo'

/**
 * The board's lanes, left to right: todo, doing, in review and done always;
 * backlog only when something is in it, cancelled only when asked for.
 */
export const boardLanes = (todos: Pick<Todo, 'status'>[], showCancelled: boolean): TaskStatus[] => {
  const present = new Set(todos.map((t) => asStatus(t.status)))
  return TASK_STATUSES.filter(
    (s) =>
      s === 'todo' ||
      s === 'doing' ||
      s === 'in-review' ||
      s === 'done' ||
      (s === 'backlog' && present.has(s)) ||
      (s === 'cancelled' && showCancelled),
  )
}

/** The list's groups: work in hand first, then what waits, then what is settled. Empty groups are left out. */
const LIST_ORDER: TaskStatus[] = ['doing', 'in-review', 'todo', 'backlog', 'done', 'cancelled']

export const listGroups = <T extends Pick<Todo, 'status'>>(todos: T[], showCancelled: boolean) =>
  LIST_ORDER.filter((s) => s !== 'cancelled' || showCancelled)
    .map((status) => ({ status, todos: todos.filter((t) => asStatus(t.status) === status) }))
    .filter((group) => group.todos.length > 0)

/**
 * Whether a move needs a resolution first. A todo already in Done or Cancelled
 * carries one, so moving between those two does not ask again.
 */
export const needsResolution = (from: string, to: TaskStatus) =>
  isTerminal(to) && !isTerminal(asStatus(from))

/** Whether the tracker it was handed to owns this todo's status, so nothing here may move it. */
export const statusLocked = (todo: Pick<Todo, 'handoff'>) => handoffIsOpen(todo.handoff)

export const tally = (todos: Pick<Todo, 'status'>[]) => {
  const done = todos.filter((t) => t.status === 'done').length
  const cancelled = todos.filter((t) => t.status === 'cancelled').length
  return { open: todos.length - done - cancelled, done, cancelled }
}
