'use client'

import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDroppable, useDraggable, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownPreview } from '@/components/markdown'
import { Avatar, LabelPill, PriorityIcon, TypePill } from '@/components/icons'
import { ResolutionDialog } from './resolution-dialog'
import { cn } from '@/lib/utils'
import { TASK_STATUSES, isTerminal, type ResolutionKind, type TaskStatus } from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'

const COLUMN_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const Card = ({ task, projectKey }: { task: TaskListItem; projectKey: string }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'bg-surface border-border hover:border-border-strong group cursor-grab rounded-md border p-2.5 transition-colors',
        isDragging && 'opacity-40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Link
          href={`/projects/${projectKey}/tasks/${task.number}`}
          className="text-fg-subtle hover:text-accent shrink-0 font-mono text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          {projectKey}-{task.number}
        </Link>
        <TypePill type={task.type} />
        <PriorityIcon priority={task.priority} />
        {task.claimed_by && (
          <span className="ml-auto" title={`Held by ${task.claimed_by}`}>
            <Avatar name={task.claimed_by} size={16} />
          </span>
        )}
      </div>

      <Link
        href={`/projects/${projectKey}/tasks/${task.number}`}
        className="block text-[13px] leading-snug font-medium"
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>

      {task.preview ? (
        <div className="mt-1.5">
          <MarkdownPreview lines={2}>{task.preview}</MarkdownPreview>
        </div>
      ) : null}

      {task.has_resolution ? (
        <p className="text-status-done mt-1.5 line-clamp-2 text-[11px] leading-snug">
          {task.resolution_kind ?? 'resolved'}
        </p>
      ) : null}

      {task.blocked_reason ? (
        <p className="text-danger mt-1.5 line-clamp-1 text-[11px]">blocked: {task.blocked_reason}</p>
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
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className="text-xs font-medium">{COLUMN_LABEL[status]}</span>
        <span className="text-fg-subtle tabular text-[11px]">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-1.5 rounded-md p-1 transition-colors',
          isOver && 'bg-accent-subtle',
        )}
      >
        {tasks.map((task) => (
          <Card key={task.id} task={task} projectKey={projectKey} />
        ))}
      </div>
    </div>
  )
}

export const BoardView = ({
  tasks: initial,
  projectKey,
}: {
  tasks: TaskListItem[]
  projectKey: string
}) => {
  const router = useRouter()
  const [tasks, setTasks] = useState(initial)
  const [dragging, setDragging] = useState<TaskListItem | null>(null)
  const [pendingClose, setPendingClose] = useState<{ task: TaskListItem; status: TaskStatus } | null>(null)

  // A small activation distance, so clicking a link inside a card does not
  // start a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const persist = async (
    task: TaskListItem,
    status: TaskStatus,
    close?: { resolution: string; kind: ResolutionKind; duplicateOf?: string },
  ) => {
    const previous = tasks
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, status } : t)))

    const res = await fetch(`/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        close
          ? {
              status,
              resolution: close.resolution,
              resolutionKind: close.kind,
              ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
            }
          : { status },
      ),
    })

    if (!res.ok) {
      setTasks(previous) // roll back rather than leave the board lying
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
      <DndContext
        sensors={sensors}
        onDragStart={({ active }: DragStartEvent) =>
          setDragging(tasks.find((t) => t.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-4">
          {TASK_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              projectKey={projectKey}
              tasks={tasks.filter((t) => t.status === status)}
            />
          ))}
        </div>

        <DragOverlay>
          {dragging ? (
            <div className="bg-surface border-accent w-64 rounded-md border p-2.5 shadow-lg">
              <p className="text-[13px] font-medium">{dragging.title}</p>
            </div>
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
