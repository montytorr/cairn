'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  useDraggable, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownPreview } from '@/components/markdown'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { COLUMN_PANEL, COLUMN_WIDTH, ColumnCount, DragPreview, DropList, laneTone } from '@/components/board-columns'
import { ResolutionDialog } from './resolution-dialog'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import { TASK_STATUSES, isTerminal, type ResolutionKind, type TaskStatus } from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'
import { TaskRelations } from '@/components/task-relations'

const COLUMN_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const Card = ({
  task,
  projectKey,
  showProjectBadge,
}: {
  task: TaskListItem
  projectKey: string
  /** The cross-project board's whole reason for existing: which project a
   * card belongs to. Off by default — the per-project board already has that
   * context from its own header. */
  showProjectBadge?: boolean
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'surface-card surface-card-interactive group cursor-grab p-2.5',
        'focus-visible:outline-accent/60 focus-visible:outline-2 focus-visible:outline-offset-1',
        // The card left behind while its preview is in the hand: a ghost of
        // where it came from, not a second copy.
        isDragging && 'opacity-40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {showProjectBadge && <ProjectIcon size={11} projectKey={projectKey} />}
        <Link
          href={`/projects/${projectKey}/tasks/${task.number}`}
          className="text-fg-subtle hover:text-accent shrink-0 font-mono text-meta"
          onClick={(e) => e.stopPropagation()}
        >
          {projectKey}-{task.number}
        </Link>
        <TypePill type={task.type} />
        <PriorityIcon priority={task.priority} />
        <span className="ml-auto flex items-center gap-1">
          {task.assignee && (
            <span className="flex" title={`Assignee: ${task.assignee.name}`}>
              <Avatar name={task.assignee.name} size={16} />
            </span>
          )}
          {task.claimed_by && (
            <span className="flex" title={`Held by ${task.claimed_by}`}>
              <Avatar name={task.claimed_by} size={16} />
            </span>
          )}
        </span>
      </div>

      <Link
        href={`/projects/${projectKey}/tasks/${task.number}`}
        className="block text-ui leading-snug font-medium"
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>

      {/* Whose child, how far its children have got, what it waits on. Kept
          off the card's own click, like the ref and the title. */}
      {task.parent_ref || task.children || task.waiting_on?.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1" onClick={(e) => e.stopPropagation()}>
          <TaskRelations task={task} />
        </div>
      ) : null}

      {task.preview ? (
        <div className="mt-1.5">
          <MarkdownPreview lines={2}>{task.preview}</MarkdownPreview>
        </div>
      ) : null}

      {task.has_resolution ? (
        <p className="text-status-done mt-1.5 line-clamp-2 text-meta leading-snug">
          {task.resolution_kind ?? 'resolved'}
        </p>
      ) : null}

      {task.blocked_reason ? (
        <p className="text-danger mt-1.5 line-clamp-1 text-meta">blocked: {task.blocked_reason}</p>
      ) : null}

      {task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.labels.slice(0, 3).map((l) => (
            <LabelPill key={l}>{l}</LabelPill>
          ))}
        </div>
      )}
    </div>
  )
}

const Column = ({
  status,
  tasks,
  projectKey,
}: {
  status: TaskStatus
  tasks: TaskListItem[]
  projectKey: string
}) => (
  <section className={cn(COLUMN_PANEL, 'h-full', COLUMN_WIDTH)} style={laneTone(`var(--status-${status})`)}>
    <div className="flex h-8 items-center gap-2 px-2.5">
      <StatusIcon status={status} size={13} />
      <span className="text-fg text-meta font-medium">{COLUMN_LABEL[status]}</span>
      <ColumnCount count={tasks.length} />
    </div>
    <DropList dropId={status} count={tasks.length} className="min-h-0 flex-1 overscroll-y-contain">
      {tasks.map((task) => (
        <Card key={task.id} task={task} projectKey={projectKey} />
      ))}
    </DropList>
  </section>
)

export const BoardView = ({
  tasks: initial,
  projectKey,
}: {
  tasks: TaskListItem[]
  projectKey: string
}) => {
  const router = useRouter()
  const request = useMutate()
  const [tasks, setTasks] = useState(initial)
  // cross-project-board.tsx has carried this reconcile since it was written;
  // this board never got it, so a card moved by an agent stayed where it was
  // until a reload. Adjusted during render rather than in an effect, and this
  // is also what settles the optimistic drag below against what the server
  // actually did.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTasks(initial)
  }
  const [dragging, setDragging] = useState<TaskListItem | null>(null)
  const [pendingClose, setPendingClose] = useState<{ task: TaskListItem; status: TaskStatus } | null>(null)

  // A small activation distance, so clicking a link inside a card does not
  // start a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  const persist = async (
    task: TaskListItem,
    status: TaskStatus,
    close?: { resolution: string; kind: ResolutionKind; duplicateOf?: string },
  ) => {
    const previous = tasks
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, status } : t)))

    const result = await request(`/api/v1/tasks/${task.id}`, {
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

    // Rolling back silently made a refused drag look like a card that would
    // not stay put. A dropped connection was worse: the fetch threw, this
    // line never ran, and the card stayed in a lane it never reached.
    if (!result.ok) {
      setTasks(previous)
      return false
    }
    router.refresh()
    return true
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return

    const task = tasks.find((t) => t.id === active.id)
    const status = over.id as TaskStatus
    if (!task || task.status === status) return

    /**
     * Closing requires a resolution, so a drag into Done or Cancelled has to
     * ask for one rather than fire a PATCH that the API will reject. This is a
     * direct consequence of making resolutions mandatory — worth the friction,
     * but it has to be handled here or dragging would just silently fail.
     */
    if (isTerminal(status) && !task.has_resolution) {
      setPendingClose({ task, status })
      return
    }

    await persist(task, status)
  }

  return (
    <>
      {/* A fixed id: dnd-kit otherwise numbers its aria-describedby from a
          module counter that the server and the client do not share. */}
      <DndContext
        id={`project-board-${projectKey}`}
        sensors={sensors}
        onDragStart={({ active }: DragStartEvent) =>
          setDragging(tasks.find((t) => t.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="scroll-visible h-full snap-x scroll-px-3 overflow-auto md:snap-none">
          <div className="flex h-full w-max gap-2.5 p-3">
            {TASK_STATUSES.map((status) => (
              <Column
                key={status}
                status={status}
                projectKey={projectKey}
                tasks={tasks.filter((t) => t.status === status)}
              />
            ))}
          </div>
        </div>

        <DragOverlay>
          {dragging ? (
            <DragPreview title={dragging.title} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingClose && (
        <ResolutionDialog
          taskTitle={pendingClose.task.title}
          status={pendingClose.status}
          suggestion={pendingClose.task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind, duplicateOf) => {
            const ok = await persist(pendingClose.task, pendingClose.status, {
              resolution,
              kind,
              duplicateOf,
            })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </>
  )
}
