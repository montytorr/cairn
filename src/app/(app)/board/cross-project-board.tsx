'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { Card } from '../projects/[key]/board-view'
import { ResolutionDialog } from '../projects/[key]/resolution-dialog'
import { useMutate } from '@/lib/api/use-mutate'
import { BoardToolbar } from './board-toolbar'
import { COLUMN_PANEL, COLUMN_WIDTH, ColumnCount, DragPreview, DropList } from '@/components/board-columns'
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
  type Swimlane,
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
          <span className="border-border size-[0.875rem] shrink-0 rounded-full border border-dashed" />
        ) : (
          <Avatar name={col.value} size={14} />
        ))}
      <span className="truncate text-xs font-medium">{col.label}</span>
    </span>
  )
}

const CardList = ({
  dropId,
  tasks,
  className,
}: {
  dropId: string
  tasks: BoardTask[]
  className?: string
}) => (
  <DropList dropId={dropId} count={tasks.length} className={className}>
    {tasks.map((task) => (
      <Card key={task.id} task={task} projectKey={task.project_key} showProjectBadge />
    ))}
  </DropList>
)

const ColumnHeader = ({ groupBy, col, count }: { groupBy: GroupBy; col: ColumnDef; count: number }) => (
  <div className="flex h-8 items-center gap-2 px-2.5">
    <ColumnHeading groupBy={groupBy} col={col} />
    <ColumnCount count={count} />
  </div>
)

/** No swimlanes: every column is as tall as the board and scrolls on its own. */
const FlatBoard = ({
  groupBy,
  columns,
  tasks,
}: {
  groupBy: GroupBy
  columns: ColumnDef[]
  tasks: BoardTask[]
}) => (
  <div className="flex h-full w-max gap-2.5 p-3">
    {columns.map((col) => {
      const cards = tasks.filter((t) => groupValue(t, groupBy) === col.value)
      return (
        <section
          key={col.value}
          className={cn(COLUMN_PANEL, 'h-full', COLUMN_WIDTH)}
        >
          <ColumnHeader groupBy={groupBy} col={col} count={cards.length} />
          <CardList dropId={`all${SEP}${col.value}`} tasks={cards} className="min-h-0 flex-1 overscroll-contain" />
        </section>
      )
    })}
  </div>
)

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
}) => {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section>
      {/* Sticky on the left so the lane stays named while the board is
          scrolled sideways past its first columns. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="text-fg-muted hover:text-fg sticky left-3 mb-1.5 flex w-fit items-center gap-1.5 rounded px-1 py-0.5 text-[0.75rem] font-medium transition-colors"
      >
        <ChevronRight size={13} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        {lane.label}
        <span className="text-fg-subtle tabular">{tasks.length}</span>
      </button>

      {!collapsed && (
        <div className="flex gap-2.5">
          {columns.map((col) => (
            <div
              key={col.value}
              className={cn(COLUMN_PANEL, COLUMN_WIDTH)}
            >
              <CardList
                dropId={`${lane.value}${SEP}${col.value}`}
                tasks={tasks.filter((t) => groupValue(t, groupBy) === col.value)}
                className="max-h-[min(26rem,55dvh)] flex-1"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Swimlanes cannot each be as tall as the viewport, so a cell is capped and
 * scrolls on its own while the board scrolls down through the lanes. The
 * column headings are drawn once and stick to the top instead of repeating
 * in every lane.
 */
const LaneBoard = ({
  groupBy,
  columns,
  lanes,
  swimlane,
  tasks,
}: {
  groupBy: GroupBy
  columns: ColumnDef[]
  lanes: ColumnDef[]
  swimlane: Swimlane
  tasks: BoardTask[]
}) => (
  <div className="w-max min-w-full pb-3">
    <div className="bg-bg/95 sticky top-0 z-10 flex gap-2.5 px-3 pt-3 pb-2 backdrop-blur">
      {columns.map((col) => (
        <div key={col.value} className={cn('bg-bg-elevated border-border shrink-0 rounded-lg border', COLUMN_WIDTH)}>
          <ColumnHeader
            groupBy={groupBy}
            col={col}
            count={tasks.filter((t) => groupValue(t, groupBy) === col.value).length}
          />
        </div>
      ))}
    </div>
    <div className="flex flex-col gap-4 px-3 pt-1">
      {lanes.map((lane) => (
        <Lane
          key={lane.value}
          lane={lane}
          groupBy={groupBy}
          columns={columns}
          tasks={tasks.filter((t) => laneValueOf(t, swimlane) === lane.value)}
        />
      ))}
    </div>
  </div>
)

export const CrossProjectBoard = ({
  tasks: initial,
  projects,
  initialQuery,
}: {
  tasks: BoardTask[]
  projects: BoardProject[]
  /** The request's query string, so the server renders the same view the
   * client hydrates: reading `window.location` alone gave the server the
   * default view and a hydration mismatch whenever a link carried a view. */
  initialQuery: string
}) => {
  const router = useRouter()
  const request = useMutate()
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

  const [filters, setFiltersState] = useState<BoardFilters>(() => parseFilters(initialQuery))
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
    const result =
      filters.groupBy === 'agent'
        ? value === UNASSIGNED
          ? await request(`/api/v1/tasks/${ref}/release`, { method: 'POST' })
          : await request(`/api/v1/tasks/${ref}/claim`, {
              method: 'POST',
              body: { agent: value, setDoing: false },
            })
        : await request(`/api/v1/tasks/${ref}`, {
            method: 'PATCH',
            body: close
              ? {
                  [filters.groupBy]: value,
                  resolution: close.resolution,
                  resolutionKind: close.kind,
                  ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
                }
              : { [filters.groupBy]: value },
          })

    // Grouped by agent this is the board's own way of reassigning work, and
    // the claim is refused while the current holder's lease is still live.
    // Rolling the card back without a word made that look like a glitch
    // rather than "someone else is holding this".
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
    <div className="flex h-full flex-col">
      {/* Outside the scroll box and above it: the filter popovers hang below
          this row, over the board, and must never be clipped by it. */}
      <div className="relative z-20 shrink-0">
        <BoardToolbar filters={filters} onChange={setFilters} projects={projects} agentOptions={agentOptions} />
      </div>

      {/* A fixed id: dnd-kit otherwise numbers its aria-describedby from a
          module counter that the server and the client do not share. */}
      <DndContext
        id="cross-project-board"
        sensors={sensors}
        onDragStart={({ active }: DragStartEvent) =>
          setDragging(tasks.find((t) => t.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="min-h-0 flex-1 snap-x scroll-px-3 overflow-auto md:snap-none">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-fg-subtle text-[0.8125rem]">Nothing matches these filters.</p>
              <button
                type="button"
                onClick={() =>
                  setFilters({ ...parseFilters(''), groupBy: filters.groupBy, swimlane: filters.swimlane })
                }
                className="text-accent text-[0.75rem] hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : effectiveSwimlane === 'none' ? (
            <FlatBoard groupBy={filters.groupBy} columns={columns} tasks={visible} />
          ) : (
            <LaneBoard
              groupBy={filters.groupBy}
              columns={columns}
              lanes={lanes}
              swimlane={effectiveSwimlane}
              tasks={visible}
            />
          )}
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
