'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  useDroppable, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '../projects/[key]/board-view'
import { ResolutionDialog } from '../projects/[key]/resolution-dialog'
import { BoardToolbar } from './board-toolbar'
import { cn } from '@/lib/utils'
import { Avatar, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { isTerminal, type ResolutionKind, type TaskPriority, type TaskStatus, type TaskType } from '@/schemas/task'
import type { BoardProject, BoardTask } from '@/lib/board-data'
import {
  SEP,
  UNASSIGNED,
  applyGroupValue,
  buildBoardUrl,
  columnsFor,
  groupValue,
  laneValueOf,
  lanesFor,
  matchesFilters,
  parseFilters,
  type BoardFilters,
  type ColumnDef,
  type GroupBy,
} from '@/lib/board-state'

const ColumnHeading = ({ groupBy, col }: { groupBy: GroupBy; col: ColumnDef }) => {
  if (groupBy === 'type') return <TypePill type={col.value as TaskType} />

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {groupBy === 'status' && <StatusIcon status={col.value as TaskStatus} size={13} />}
      {groupBy === 'priority' && <PriorityIcon priority={col.value as TaskPriority} />}
      {groupBy === 'project' && <ProjectIcon size={13} projectKey={col.value} />}
      {groupBy === 'agent' &&
        (col.value === UNASSIGNED ? (
          <span className="border-border size-[14px] shrink-0 rounded-full border border-dashed" />
        ) : (
          <Avatar name={col.value} size={14} />
        ))}
      <span className="truncate text-xs font-medium">{col.label}</span>
    </span>
  )
}

const Column = ({
  laneValue,
  groupBy,
  col,
  tasks,
}: {
  laneValue: string
  groupBy: GroupBy
  col: ColumnDef
  tasks: BoardTask[]
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneValue}${SEP}${col.value}` })

  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <ColumnHeading groupBy={groupBy} col={col} />
        <span className="text-fg-subtle tabular ml-auto text-[11px]">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-1.5 rounded-md p-1 transition-colors',
          isOver && 'bg-accent-subtle',
        )}
      >
        {tasks.map((task) => (
          <Card key={task.id} task={task} projectKey={task.project_key} showProjectBadge />
        ))}
      </div>
    </div>
  )
}

const Lane = ({
  lane,
  groupBy,
  columns,
  tasks,
}: {
  lane: ColumnDef
  groupBy: GroupBy
  columns: ColumnDef[]
  tasks: BoardTask[]
}) => (
  <section>
    {lane.label && (
      <div className="text-fg-muted mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium">
        {lane.label}
        <span className="text-fg-subtle tabular">{tasks.length}</span>
      </div>
    )}
    <div className="flex gap-3">
      {columns.map((col) => (
        <Column
          key={col.value}
          laneValue={lane.value}
          groupBy={groupBy}
          col={col}
          tasks={tasks.filter((t) => groupValue(t, groupBy) === col.value)}
        />
      ))}
    </div>
  </section>
)

export const CrossProjectBoard = ({
  tasks: initial,
  projects,
}: {
  tasks: BoardTask[]
  projects: BoardProject[]
}) => {
  const router = useRouter()
  const [tasks, setTasks] = useState(initial)
  // Adjusted during render rather than in an effect (the pattern React's docs
  // recommend for "reset state when a prop changes"): `router.refresh()`
  // re-renders this component with a new `tasks` prop — fresh from the
  // server, e.g. with the renumbering a project move causes — and this is
  // what reconciles the optimistic guess with what actually happened.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTasks(initial)
  }

  const [filters, setFiltersState] = useState<BoardFilters>(() =>
    parseFilters(typeof window === 'undefined' ? '' : window.location.search),
  )
  const [dragging, setDragging] = useState<BoardTask | null>(null)
  const [pendingClose, setPendingClose] = useState<{ task: BoardTask; value: string } | null>(null)

  const setFilters = (next: BoardFilters) => {
    setFiltersState(next)
    if (typeof window !== 'undefined') {
      window.history.replaceState(
        null,
        '',
        buildBoardUrl(window.location.pathname, next, window.location.search),
      )
    }
  }

  // A swimlane grouped by the same field the columns already are would just
  // draw a diagonal of one card per cell — redundant rather than useful.
  const effectiveSwimlane = filters.swimlane === filters.groupBy ? 'none' : filters.swimlane

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Arrow keys move the picked-up card; Space/Enter drops it. dnd-kit wires
    // this up automatically once a KeyboardSensor exists — the draggable's
    // own `tabIndex`/`role` (from `useDraggable`'s `attributes`) is already in
    // place on the card, same as the per-project board.
    useSensor(KeyboardSensor),
  )

  const visible = useMemo(() => tasks.filter((t) => matchesFilters(t, filters)), [tasks, filters])
  const columns = useMemo(() => columnsFor(filters.groupBy, tasks, projects), [filters.groupBy, tasks, projects])
  const lanes = useMemo(
    () => lanesFor(effectiveSwimlane, visible, projects),
    [effectiveSwimlane, visible, projects],
  )
  const agentOptions = useMemo(
    () => [...new Set(tasks.map((t) => t.claimed_by).filter((a): a is string => Boolean(a)))].sort(),
    [tasks],
  )

  const persist = async (
    task: BoardTask,
    value: string,
    close?: { resolution: string; kind: ResolutionKind; duplicateOf?: string },
  ) => {
    const previous = tasks
    setTasks((current) =>
      current.map((t) => (t.id === task.id ? applyGroupValue(t, filters.groupBy, value) : t)),
    )

    const ref = `${task.project_key}-${task.number}`

    // Agent isn't a plain PATCH-able column: claiming and releasing are their
    // own endpoints with concurrency rules (stealing a lease, refusing to
    // steal a live one), and reusing them here is what keeps a drag honest
    // about "held by someone else" rather than silently overwriting it.
    const res =
      filters.groupBy === 'agent'
        ? value === UNASSIGNED
          ? await fetch(`/api/v1/tasks/${ref}/release`, { method: 'POST' })
          : await fetch(`/api/v1/tasks/${ref}/claim`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agent: value, setDoing: false }),
            })
        : await fetch(`/api/v1/tasks/${ref}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              close
                ? {
                    [filters.groupBy]: value,
                    resolution: close.resolution,
                    resolutionKind: close.kind,
                    ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
                  }
                : { [filters.groupBy]: value },
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
    if (!task) return

    const value = String(over.id).split(SEP)[1]
    if (!value || groupValue(task, filters.groupBy) === value) return

    // Same rule the per-project board enforces: a drag into Done or
    // Cancelled needs a resolution before it can be sent as a PATCH.
    if (filters.groupBy === 'status' && isTerminal(value as TaskStatus) && !task.has_resolution) {
      setPendingClose({ task, value })
      return
    }

    await persist(task, value)
  }

  return (
    <div>
      <BoardToolbar filters={filters} onChange={setFilters} projects={projects} agentOptions={agentOptions} />

      <div className="p-3">
        <DndContext
          sensors={sensors}
          onDragStart={({ active }: DragStartEvent) =>
            setDragging(tasks.find((t) => t.id === active.id) ?? null)
          }
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {visible.length === 0 ? (
            <p className="text-fg-subtle py-16 text-center text-[13px]">Nothing matches these filters.</p>
          ) : (
            <div className="flex flex-col gap-4 overflow-x-auto pb-4">
              {lanes.map((lane) => (
                <Lane
                  key={lane.value}
                  lane={lane}
                  groupBy={filters.groupBy}
                  columns={columns}
                  tasks={visible.filter((t) => laneValueOf(t, effectiveSwimlane) === lane.value)}
                />
              ))}
            </div>
          )}

          <DragOverlay>
            {dragging ? (
              <div className="bg-surface border-accent w-64 rounded-md border p-2.5 shadow-lg">
                <p className="text-[13px] font-medium">{dragging.title}</p>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {pendingClose && (
        <ResolutionDialog
          taskTitle={pendingClose.task.title}
          status={pendingClose.value as TaskStatus}
          suggestion={pendingClose.task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind, duplicateOf) => {
            const ok = await persist(pendingClose.task, pendingClose.value, { resolution, kind, duplicateOf })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </div>
  )
}
