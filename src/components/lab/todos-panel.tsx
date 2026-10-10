'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Avatar, PriorityIcon, StatusIcon } from '@/components/icons'
import {
  COLUMN_PANEL, COLUMN_WIDTH, ColumnCount, DragPreview, DropList, laneTone,
} from '@/components/board-columns'
import { EmptyState } from '@/components/empty-state'
import { Button, Checkbox, Input, Select } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { ViewToggle } from '@/app/(app)/projects/[key]/view-switch'
import { ResolutionDialog } from '@/app/(app)/projects/[key]/resolution-dialog'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import type { ProjectView } from '@/lib/project-view'
import {
  TASK_STATUSES, type ResolutionKind, type TaskPriority, type TaskStatus,
} from '@/schemas/task'
import { HandoffBadge } from './handoff-badge'
import {
  STATUS_LABEL, asStatus, boardLanes, listGroups, needsResolution, statusLocked, tally,
} from './todo-lanes'
import { taskHref, type Todo } from './types'

const LOCKED_TITLE = 'Handed off: the other tracker owns this status. Take it back to change it here.'

type Close = { resolution: string; kind: ResolutionKind; duplicateOf?: string }

/**
 * The write behind every status change, wherever it started: a list's select
 * or a dragged card. A refused change (a hand-off opened in between) comes back
 * as false and is shown by `useMutate`'s toast.
 */
const useTodoStatus = () => {
  const router = useRouter()
  const request = useMutate()
  return useCallback(
    async (todo: Todo, status: TaskStatus, close?: Close) => {
      const result = await request(`/api/v1/tasks/${todo.id}`, {
        method: 'PATCH',
        body: close
          ? {
              status,
              resolution: close.resolution,
              resolutionKind: close.kind,
              ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
            }
          : { status },
      })
      if (result.ok) router.refresh()
      return result.ok
    },
    [request, router],
  )
}

const TodoMeta = ({ todo }: { todo: Todo }) => (
  <>
    {todo.handoff ? <HandoffBadge handoff={todo.handoff} /> : null}
    <PriorityIcon priority={todo.priority as TaskPriority} />
    {todo.assignee ? (
      <span className="flex" title={`Assignee: ${todo.assignee.name}`}>
        <Avatar name={todo.assignee.name} size={16} />
      </span>
    ) : null}
  </>
)

const ListRow = ({
  todo,
  onStatus,
}: {
  todo: Todo
  onStatus: (todo: Todo, status: TaskStatus) => void
}) => {
  const locked = statusLocked(todo)
  const href = taskHref(todo.ref)
  const status = asStatus(todo.status)
  return (
    <li className="row-hover flex min-h-[2.25rem] flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-1">
      <StatusIcon status={status} />
      {href ? (
        <Link href={href} className="text-fg-subtle hover:text-accent shrink-0 font-mono text-meta">
          {todo.ref}
        </Link>
      ) : (
        <span className="text-fg-subtle shrink-0 font-mono text-meta">{todo.ref}</span>
      )}
      <span className="min-w-0 flex-1 basis-40">
        {href ? (
          <Link href={href} className="text-fg block truncate text-ui">
            {todo.title}
          </Link>
        ) : (
          <span className="text-fg block truncate text-ui">{todo.title}</span>
        )}
      </span>
      <TodoMeta todo={todo} />
      <Select
        size="sm"
        value={status}
        disabled={locked}
        title={locked ? LOCKED_TITLE : undefined}
        aria-label={`Status of ${todo.ref}`}
        onChange={(e) => onStatus(todo, e.target.value as TaskStatus)}
        className="w-[8.5rem]"
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
    </li>
  )
}

const Card = ({ todo }: { todo: Todo }) => {
  const locked = statusLocked(todo)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: todo.id, disabled: locked })
  const href = taskHref(todo.ref)
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      title={locked ? LOCKED_TITLE : undefined}
      className={cn(
        'surface-card surface-card-interactive group p-2.5',
        locked ? 'cursor-default' : 'cursor-grab',
        'focus-visible:outline-accent/60 focus-visible:outline-2 focus-visible:outline-offset-1',
        isDragging && 'opacity-40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {href ? (
          <Link
            href={href}
            onClick={(e) => e.stopPropagation()}
            className="text-fg-subtle hover:text-accent shrink-0 font-mono text-meta"
          >
            {todo.ref}
          </Link>
        ) : (
          <span className="text-fg-subtle shrink-0 font-mono text-meta">{todo.ref}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <PriorityIcon priority={todo.priority as TaskPriority} />
          {todo.assignee ? <Avatar name={todo.assignee.name} size={16} /> : null}
        </span>
      </div>
      {href ? (
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="block text-ui leading-snug font-medium"
        >
          {todo.title}
        </Link>
      ) : (
        <span className="block text-ui leading-snug font-medium">{todo.title}</span>
      )}
      {todo.handoff ? (
        <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
          <HandoffBadge handoff={todo.handoff} />
        </div>
      ) : null}
    </div>
  )
}

const Lane = ({ status, todos }: { status: TaskStatus; todos: Todo[] }) => (
  <section
    className={cn(COLUMN_PANEL, 'h-full', COLUMN_WIDTH)}
    style={laneTone(`var(--status-${status})`)}
    aria-label={STATUS_LABEL[status]}
  >
    <div className="flex h-8 items-center gap-2 px-2.5">
      <StatusIcon status={status} size={13} />
      <span className="text-fg text-meta font-medium">{STATUS_LABEL[status]}</span>
      <ColumnCount count={todos.length} />
    </div>
    <DropList dropId={status} count={todos.length} className="min-h-0 flex-1 overscroll-y-contain">
      {todos.map((todo) => (
        <Card key={todo.id} todo={todo} />
      ))}
    </DropList>
  </section>
)

/**
 * A subject's todos: ordinary Cairn tasks, drawn as a list grouped by status
 * or as the same lanes a project board has. A todo handed to another tracker
 * keeps its place but cannot be moved here: that tracker owns the status.
 */
export const TodosPanel = ({
  subjectRef,
  todos: initial,
  initialView = 'list',
}: {
  subjectRef: string
  todos: Todo[]
  initialView?: ProjectView
}) => {
  const router = useRouter()
  const setStatus = useTodoStatus()
  const [view, setView] = useState<ProjectView>(initialView)
  const [from, setFrom] = useState<ProjectView | null>(null)
  const [showCancelled, setShowCancelled] = useState(false)
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<{ todo: Todo; status: TaskStatus } | null>(null)

  // Reconciled during render: an agent moving a todo arrives with the refresh.
  const [todos, setTodos] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTodos(initial)
  }
  const [dragging, setDragging] = useState<Todo | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  const cancelClose = useCallback(() => setPendingClose(null), [])
  const counts = tally(todos)
  const lanes = useMemo(() => boardLanes(todos, showCancelled), [todos, showCancelled])
  const groups = useMemo(() => listGroups(todos, showCancelled), [todos, showCancelled])

  const pick = (next: ProjectView) => {
    if (next !== view) setFrom(view)
    setView(next)
    const url = new URL(window.location.href)
    if (next === 'board') url.searchParams.set('view', 'board')
    else url.searchParams.delete('view')
    window.history.replaceState(window.history.state, '', url)
  }

  const change = async (todo: Todo, status: TaskStatus) => {
    if (statusLocked(todo) || asStatus(todo.status) === status) return
    if (needsResolution(todo.status, status)) {
      setPendingClose({ todo, status })
      return
    }
    const previous = todos
    setTodos((current) => current.map((t) => (t.id === todo.id ? { ...t, status } : t)))
    if (!(await setStatus(todo, status))) setTodos(previous)
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return
    const todo = todos.find((t) => t.id === active.id)
    if (todo) await change(todo, over.id as TaskStatus)
  }

  const add = async () => {
    if (!title.trim() || adding) return
    setAdding(true)
    setAddError(null)
    const result = await mutate(`/api/v1/subjects/${subjectRef}/todos`, {
      method: 'POST',
      body: { title: title.trim() },
    })
    setAdding(false)
    if (!result.ok) {
      setAddError(result.error)
      return
    }
    setTitle('')
    router.refresh()
  }

  return (
    <section aria-label="Todos">
      <form
        className="mb-3 flex max-w-[51.25rem] items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a todo…"
          aria-label="Add a todo"
          maxLength={300}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" disabled={!title.trim() || adding}>
          {adding ? <Spinner /> : <Plus size={14} aria-hidden />}
          <span className="hidden sm:inline">Add</span>
        </Button>
      </form>
      {addError ? (
        <p role="alert" className="text-danger mb-2 text-meta">
          {addError}
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ViewToggle view={view} from={from} onPick={pick} />
        <span className="text-fg-subtle tabular text-meta">
          {counts.open} open · {counts.done} done
        </span>
        <Checkbox
          label="Cancelled"
          checked={showCancelled}
          onChange={(e) => setShowCancelled(e.target.checked)}
          labelClassName="ml-auto"
        />
      </div>

      {todos.length === 0 ? (
        <EmptyState
          compact
          title="No todos yet."
          hint="A todo is an ordinary task, filed in the subject's project or the Lab's home project."
        />
      ) : view === 'board' ? (
        <DndContext
          id={`todos-${subjectRef}`}
          sensors={sensors}
          onDragStart={({ active }: DragStartEvent) =>
            setDragging(todos.find((t) => t.id === active.id) ?? null)
          }
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {/* The board's own scroll box: sideways on a phone, with snap. */}
          <div className="scroll-visible h-[32rem] snap-x overflow-auto md:snap-none">
            <div className="flex h-full w-max gap-2.5">
              {lanes.map((status) => (
                <Lane
                  key={status}
                  status={status}
                  todos={todos.filter((t) => asStatus(t.status) === status)}
                />
              ))}
            </div>
          </div>
          <DragOverlay>{dragging ? <DragPreview title={dragging.title} /> : null}</DragOverlay>
        </DndContext>
      ) : (
        <div className="border-border max-w-[51.25rem] overflow-hidden rounded-lg border">
          {groups.map((group) => (
            <section key={group.status} aria-label={STATUS_LABEL[group.status]}>
              <h3
                className="group-band border-border flex h-[2.125rem] items-center gap-2 border-b px-3"
                style={{ '--band': `var(--status-${group.status})` } as React.CSSProperties}
              >
                <StatusIcon status={group.status} size={13} />
                <span className="text-meta font-medium" style={{ color: `var(--status-${group.status})` }}>
                  {STATUS_LABEL[group.status]}
                </span>
                <span className="text-fg-subtle tabular text-meta">{group.todos.length}</span>
              </h3>
              <ul className="divide-border divide-y">
                {group.todos.map((todo) => (
                  <ListRow key={todo.id} todo={todo} onStatus={change} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {pendingClose ? (
        <ResolutionDialog
          taskTitle={pendingClose.todo.title}
          status={pendingClose.status}
          suggestion={null}
          onCancel={cancelClose}
          onConfirm={async (resolution, kind, duplicateOf) => {
            const ok = await setStatus(pendingClose.todo, pendingClose.status, {
              resolution,
              kind,
              duplicateOf,
            })
            if (ok) setPendingClose(null)
            return ok
          }}
        />
      ) : null}
    </section>
  )
}
