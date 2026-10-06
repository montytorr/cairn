'use client'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Clock, Plus } from 'lucide-react'
import { TaskRelations } from '@/components/task-relations'
import { nestTasks } from '@/lib/nest-tasks'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/empty-state'
import { useRenderedClaimStale } from '@/lib/use-mounted'
import { fullDateTime, shortDate } from '@/lib/dates'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  isTerminal,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'
import { NewTaskButton } from '@/components/task-creation'
import { usePeople } from '@/components/people-context'
import { AssigneeFilter, useAssigneeFilter, type AssigneeFilterState } from '@/components/assignee-filter'
import { matchesAssignees } from '@/lib/assignee-filter'
import { BulkBar } from './bulk-bar'
import { ResolutionDialog } from './resolution-dialog'
import { applySelection } from '@/lib/selection'
import { QuickSelect, useQuickPatch } from './quick-edit'
import { LabelEditor } from './label-editor'

/** A group is a status, or the synthetic bucket the Recent tab renders into. */
type GroupKey = TaskStatus | 'recent'

const GROUP_LABEL: Record<GroupKey, string> = {
  recent: 'Recently touched',
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

type Tab = 'doing' | 'todo' | 'active' | 'backlog' | 'all' | 'recent' | 'held' | 'closed'

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/**
 * The active tab's pill, which slides to whichever tab is picked instead of
 * jumping there.
 *
 * Tabs are marked `data-pill="<key>"` inside `track`; the pill is measured
 * onto the active one and moved by writing its style directly, so a slide
 * costs no React render. The first placement, and any placement caused by a
 * resize, snaps: only a change of tab moves. Until the first measurement the
 * active tab draws its own background (the track gains `data-measured` once
 * the pill has taken over), so the server render and a slow hydration still
 * show which tab is on.
 *
 * `from` is for a switch that remounts on every change (the list/board
 * toggle moves between two toolbars): it starts the new pill where the old
 * one was, so it still reads as one pill travelling.
 */
export const useSlidingPill = (active: string, from?: string | null) => {
  const track = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)

  useLayoutEffect(() => {
    const box = track.current
    const mark = pill.current
    if (!box || !mark) return

    const find = (key: string) => box.querySelector<HTMLElement>(`[data-pill="${key}"]`)
    let at = ''
    const moveTo = (el: HTMLElement, animate: boolean) => {
      const next = `${el.offsetLeft}:${el.offsetWidth}`
      if (next === at) return
      at = next
      if (!animate) mark.style.transition = 'none'
      mark.style.transform = `translateX(${el.offsetLeft}px)`
      mark.style.width = `${el.offsetWidth}px`
      mark.style.opacity = '1'
      box.setAttribute('data-measured', '')
      if (!animate) {
        // Commit the jump before the transition comes back, or it animates.
        void mark.offsetWidth
        mark.style.transition = ''
      }
    }
    const place = (animate: boolean) => {
      const el = find(active)
      if (el) {
        moveTo(el, animate)
        return
      }
      at = ''
      mark.style.opacity = '0'
      box.removeAttribute('data-measured')
    }

    if (placed.current) {
      place(true)
    } else {
      const origin = from && from !== active ? find(from) : null
      if (origin) moveTo(origin, false)
      place(Boolean(origin))
      placed.current = true
    }

    // A resize (a font landing, a tab appearing) re-measures and snaps. The
    // observer also reports once on attaching, which finds the pill already
    // where it belongs and leaves a slide in progress alone.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    observer.observe(box)
    return () => observer.disconnect()
  }, [active, from])

  return { track, pill }
}

/** The pill itself: a solid fill that slides between the tabs. */
export const PILL_CLASS = cn(
  'bg-surface-raised pointer-events-none absolute inset-y-0 left-0 rounded-md opacity-0',
  'transition-[transform,width,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)]',
)

// The rows of one group settle in one after another (`stagger`, globals.css).
const STAGGER = 'stagger'

const Row = ({
  task,
  projectKey,
  showProject,
  selected,
  selecting,
  onToggle,
  knownLabels,
  projects,
  depth = 0,
  nested = 0,
  childrenHidden = false,
  onToggleChildren,
}: {
  task: TaskListItem & { project_key?: string; guest?: boolean }
  projectKey: string
  showProject?: boolean
  selected: boolean
  selecting: boolean
  onToggle: (id: string, shiftKey: boolean) => void
  knownLabels: string[]
  projects: { key: string; title: string }[]
  /** How far under a parent shown above it this row is drawn. */
  depth?: number
  /** Sub-tasks of this row present in the same group. */
  nested?: number
  childrenHidden?: boolean
  onToggleChildren?: (id: string) => void
}) => {
  const stale = useRenderedClaimStale(task.heartbeat_at)
  const { people } = usePeople()
  const ownKey = task.project_key ?? projectKey
  const ref = `${ownKey}-${task.number}`
  const { patch, overlay, error, clearError } = useQuickPatch(ref, task.updated_at)
  const [closing, setClosing] = useState<TaskStatus | null>(null)

  // The optimistic overlay wins until the refreshed row arrives.
  const status = (overlay?.status as TaskStatus) ?? task.status
  const priority = (overlay?.priority as TaskPriority) ?? task.priority
  const type = (overlay?.type as TaskType) ?? task.type
  const labels = (overlay?.labels as string[]) ?? task.labels
  const assigneeId = (overlay?.assignee as string) ?? task.assignee_user_id
  const assignee =
    assigneeId === task.assignee_user_id
      ? task.assignee
      : (people.find((p) => p.id === assigneeId) ?? task.assignee)

  // `listPeople` only offers active users, so a task assigned to someone who
  // has since gone inactive would otherwise fall off the picker's own list.
  const assigneeChoices = people.some((p) => p.id === assigneeId)
    ? people
    : [{ id: assigneeId, name: assignee ? `${assignee.name} (inactive)` : assigneeId, email: '', active: false }, ...people]

  return (
    <div
      className={cn(
        'group relative flex h-[2.25rem] items-center',
        // Shift-click paints a text selection across the rows it passes
        // otherwise, which looks like a mistake on every range.
        'select-none',
        // A selected row gets an edge as well as a tint. On a list of three
        // hundred, a background one step off the ground is easy to lose
        // track of when scrolling; the 2px rule is not.
        selected
          ? 'bg-accent-subtle shadow-[inset_2px_0_0_var(--accent)] transition-[background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease)]'
          : 'row-hover',
      )}
    >
      {/* The whole row navigates, but the badges on it are controls. An
          absolute link underneath, with the controls raised above it, is what
          lets both be true — and keeps middle-click and cmd-click working. */}
      <Link
        href={`/projects/${ownKey}/tasks/${task.number}`}
        // A 300-row list is mostly out of view, so Next's viewport prefetch
        // does not help. Prefetching on hover is what makes the click instant.
        prefetch
        aria-label={task.title}
        className="absolute inset-0 z-0"
      />

      {/* A button, not a <label> around a checkbox.
          A label activates the control it wraps, so the click landed twice —
          once from the label's own handler and once from the forwarded
          activation — and the two toggles cancelled. The selection only
          appeared to move when the *next* row was clicked, which is exactly
          how it was reported. Drawing the box also lets it be sized for a
          finger.

          Always visible where there is no hover: on a touch screen a control
          revealed by `group-hover` can never be reached at all. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${task.title}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggle(task.id, e.shiftKey)
        }}
        className={cn(
          'relative z-10 grid h-[2.25rem] w-[1.875rem] shrink-0 place-items-center pl-3',
          // `translate`, not `transform`: Tailwind's translate utilities set
          // the individual property, which a transform transition ignores.
          'transition-[opacity,translate] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          selected || selecting
            ? 'opacity-100'
            : 'opacity-100 md:-translate-x-0.5 md:opacity-0 md:group-hover:translate-x-0 md:group-hover:opacity-100 md:focus-visible:translate-x-0 md:focus-visible:opacity-100',
        )}
      >
        <span
          className={cn(
            'grid size-[0.875rem] place-items-center rounded-[0.25rem] border',
            'transition-[background-color,border-color] duration-[var(--dur-1)] ease-[var(--ease-out)]',
            selected
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-border-strong bg-surface hover:border-accent',
          )}
        >
          {selected && (
            <svg
              width="9"
              height="9"
              viewBox="0 0 10 10"
              aria-hidden
              className="enter-pop"
              style={{ '--origin': 'center' } as React.CSSProperties}
            >
              <path
                d="M1.5 5.2l2.2 2.2L8.5 2.6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          )}
        </span>
      </button>

      <div className="pointer-events-none flex h-[2.25rem] min-w-0 flex-1 items-center gap-2 pl-1.5 pr-3 md:pr-4">
        {/* A sub-task drawn under its parent is indented, capped so a deep
            chain cannot push the title off a phone. */}
        {depth > 0 ? (
          <span aria-hidden className="shrink-0" style={{ width: `${Math.min(depth, 3) * 1.125}rem` }} />
        ) : null}
        <QuickSelect
          value={priority}
          options={TASK_PRIORITIES}
          title={`Priority: ${priority}`}
          onChange={(next) => void patch({ priority: next })}
          className="pointer-events-auto"
        >
          <PriorityIcon priority={priority} />
        </QuickSelect>

        {/* The Cairn ref, never the imported one.
            This showed `external_ref` in preference, so a task migrated from
            Linear displayed LEGACY-1234 — an identifier that looks like a ref,
            does not resolve anywhere in this system, and truncated to
            "LEGACY-1…" in a column sized for CAI-70. The search route made the
            opposite choice deliberately and says why; the list disagreed with
            it. The old identifier is kept on the element's title, so it is
            still there for anyone who has to match a task against Linear. */}
        <code
          className="text-fg-subtle hidden w-[3.875rem] shrink-0 truncate text-meta tabular sm:block md:w-[4.5rem]"
          title={task.external_ref ? `${ref} · imported as ${task.external_ref}` : ref}
        >
          {ref}
        </code>

        <QuickSelect
          value={status}
          options={TASK_STATUSES}
          labels={STATUS_LABEL}
          title={`Status: ${STATUS_LABEL[status]}`}
          // Done and Cancelled need a resolution, and the API refuses the
          // PATCH without one. Every other surface that can close a task —
          // the board, the bulk bar, the task page — asks for it first; this
          // one fired the doomed request and printed "refused" in 11px,
          // which is why cancelling from the list looked broken.
          onChange={(next) => {
            if (isTerminal(next) && !task.has_resolution) {
              setClosing(next)
              return
            }
            void patch({ status: next })
          }}
          className="pointer-events-auto"
        >
          <StatusIcon status={status} />
        </QuickSelect>

        {/* The brightest thing on the row: everything around it is a grey or
            a tint, so the eye lands on the title and reads across. */}
        {nested > 0 ? (
          <button
            type="button"
            onClick={() => onToggleChildren?.(task.id)}
            aria-expanded={!childrenHidden}
            aria-label={`${childrenHidden ? 'Show' : 'Hide'} ${nested} sub-task${nested === 1 ? '' : 's'}`}
            title={`${childrenHidden ? 'Show' : 'Hide'} ${nested} sub-task${nested === 1 ? '' : 's'}`}
            className="text-fg-subtle hover:text-fg pointer-events-auto relative z-10 -mx-0.5 grid size-[1.125rem] shrink-0 place-items-center rounded transition-colors"
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform duration-[var(--dur-1)]', !childrenHidden && 'rotate-90')}
              aria-hidden
            />
          </button>
        ) : null}
        <span className="text-fg min-w-0 flex-1 truncate text-ui">{task.title}</span>

        {/* Whose child, how far its own children have got, what it waits on.
            The parent is not repeated on a row drawn directly under it. */}
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          <TaskRelations task={task} showParent={depth === 0} />
        </span>

        {/* Filed in another project and linked here. Without saying so, a row
            reading CAIRN-83 in the HM list reads as a bug rather than as work
            that genuinely spans both. */}
        {task.guest && (
          <span
            title={`Filed in ${ownKey}, also belongs here`}
            className="border-border text-fg-subtle pointer-events-auto hidden shrink-0 rounded border px-1.5 py-px text-label tracking-wide uppercase sm:inline"
          >
            guest
          </span>
        )}

        {error ? (
          <button
            type="button"
            onClick={clearError}
            title={error}
            className="text-danger pointer-events-auto shrink-0 text-meta"
          >
            refused
          </button>
        ) : null}

        {task.blocked_reason ? (
          <span
            className="text-danger shrink-0 text-meta"
            title={`Blocked: ${task.blocked_reason}`}
          >
            blocked
          </span>
        ) : null}

        {task.has_resolution ? (
          <span
            className="bg-status-done size-[0.375rem] shrink-0 rounded-full"
            title="Has a recorded resolution"
          />
        ) : null}

        {showProject && projects.length > 0 ? (
          <QuickSelect
            value={ownKey}
            options={projects.map((p) => p.key)}
            labels={Object.fromEntries(projects.map((p) => [p.key, p.title]))}
            title={`Project: ${ownKey} — moving renumbers the task`}
            onChange={(next) => void patch({ project: next })}
            className="text-fg-muted pointer-events-auto hidden items-center gap-1.5 text-meta md:inline-flex"
          >
            <ProjectIcon size={12} projectKey={ownKey} />
            {ownKey}
          </QuickSelect>
        ) : null}

        <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
          <LabelEditor
            taskRef={ref}
            labels={labels}
            known={knownLabels}
            onChange={(next) => void patch({ labels: next })}
          />
          <QuickSelect
            value={type}
            options={TASK_TYPES}
            title={`Type: ${type}`}
            onChange={(next) => void patch({ type: next })}
            className="pointer-events-auto"
          >
            <TypePill type={type} />
          </QuickSelect>
        </span>

        <QuickSelect
          value={assigneeId}
          options={assigneeChoices.map((p) => p.id)}
          labels={Object.fromEntries(assigneeChoices.map((p) => [p.id, p.name]))}
          title={`Assignee: ${assignee?.name ?? 'unknown'}`}
          onChange={(next) => void patch({ assignee: next })}
          className="pointer-events-auto"
        >
          <Avatar name={assignee?.name ?? '?'} size={18} />
        </QuickSelect>

        {task.claimed_by ? (
          <span
            className={cn('flex shrink-0', stale && 'opacity-40')}
            title={
              stale
                ? `${task.claimed_by} holds this but has gone quiet`
                : `Held by ${task.claimed_by}`
            }
          >
            <Avatar name={task.claimed_by} size={18} />
          </span>
        ) : (
          <span className="border-border hidden size-[1.125rem] shrink-0 rounded-full border border-dashed sm:block" />
        )}

        <time
          dateTime={task.updated_at}
          title={fullDateTime(task.updated_at)}
          className="text-fg-subtle tabular hidden w-[2.875rem] shrink-0 text-right text-meta md:block"
        >
          {shortDate(task.updated_at)}
        </time>
      </div>

      {closing && (
        <ResolutionDialog
          taskTitle={task.title}
          status={closing}
          suggestion={task.checkpoint_summary}
          onCancel={() => setClosing(null)}
          onConfirm={async (resolution, kind, duplicateOf) => {
            const ok = await patch({
              status: closing,
              resolution,
              resolutionKind: kind,
              ...(duplicateOf ? { duplicateOf } : {}),
            })
            if (ok) setClosing(null)
            return ok
          }}
        />
      )}
    </div>
  )
}

export const ListView = ({
  tasks,
  recentlyClosed = [],
  projectKey,
  showProject,
  projects = [],
  toolbarExtra,
  initialAssignee,
  assigneeFilter,
}: {
  tasks: (TaskListItem & { project_key?: string })[]
  /**
   * Fetched separately and bounded, not filtered out of `tasks`: almost
   * everything here is closed, so loading it all to show the last forty would
   * mean paying for two thousand rows to render forty.
   */
  recentlyClosed?: (TaskListItem & { project_key?: string })[]
  projectKey: string
  showProject?: boolean
  /** Offered when a row shows its project, so it can be moved from the list. */
  projects?: { key: string; title: string }[]
  /** The view toggle, so it does not need a band of its own above the list. */
  toolbarExtra?: React.ReactNode
  /** The page's `assignee` param, so the first render already shows the right people. */
  initialAssignee?: string | null
  /** Shared with a sibling view (the project board) so switching keeps the choice. */
  assigneeFilter?: AssigneeFilterState
}) => {
  const ownAssignees = useAssigneeFilter(initialAssignee)
  const assignees = assigneeFilter ?? ownAssignees
  const [tab, setTab] = useState<Tab>('doing')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Parents whose sub-tasks are folded away; open by default. */
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const toggleFolded = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [knownLabels, setKnownLabels] = useState<string[]>([])

  // Fetched once for the whole list. Offering what already exists is what
  // keeps a fourth spelling of "database" from appearing.
  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/v1/labels')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      setKnownLabels(((json?.data ?? []) as { label: string }[]).map((l) => l.label))
    }
    void load()
  }, [])
  const filterRef = useRef<HTMLInputElement>(null)
  // Anchor for shift-click range selection, in the order the rows are shown.
  const lastPicked = useRef<string | null>(null)

  // Keyboard shortcuts, in the spirit of the tool this is modelled on.
  // Deliberately inert while a field has focus — "/" is a character before it
  // is a command.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        if (e.key === 'Escape') el.blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '/') {
        e.preventDefault()
        filterRef.current?.focus()
      }
      if (e.key === 'Escape') setSelected(new Set())
      if (e.key === '1') setTab('doing')
      if (e.key === '2') setTab('todo')
      if (e.key === '3') setTab('active')
      if (e.key === '4') setTab('backlog')
      if (e.key === '5') setTab('all')
      if (e.key === '6') setTab('recent')
      if (e.key === '7') setTab('closed')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // The closed tab reads from its own list. Every other tab is a view of the
  // open work, and mixing finished tasks into "All" would change what that has
  // always meant.
  //
  // Whose tasks comes first, so every tab and count is about the same people:
  // "Mine" used to be a tab of its own, which could not say "mine, in progress".
  const pool = tab === 'closed' ? recentlyClosed : tasks
  const source = useMemo(
    () => pool.filter((t) => matchesAssignees(t, assignees.selected)),
    [pool, assignees.selected],
  )

  const filtered = useMemo(() => {
    const byTab = source.filter((t) => {
      if (tab === 'closed') return true
      if (tab === 'doing') return t.status === 'doing' || t.status === 'in-review'
      if (tab === 'todo') return t.status === 'todo'
      if (tab === 'active')
        return t.status === 'doing' || t.status === 'in-review' || t.status === 'todo'
      if (tab === 'backlog') return t.status === 'backlog'
      if (tab === 'held') return Boolean(t.claimed_by)
      return true
    })
    if (!query) return byTab
    const q = query.toLowerCase()
    return byTab.filter((t) =>
      `${t.title} ${t.preview ?? ''} ${t.labels.join(' ')} ${t.external_ref ?? ''}`
        .toLowerCase()
        .includes(q),
    )
  }, [source, tab, query])

  const groups = useMemo(() => {
    if (tab === 'recent') {
      return [
        {
          status: 'recent' as GroupKey,
          items: [...filtered]
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
            .slice(0, 50),
          total: filtered.length,
        },
      ]
    }
    return (
      TASK_STATUSES.map((status) => ({
        status: status as GroupKey,
        items: filtered.filter((t) => t.status === status),
        total: source.filter((t) => t.status === status).length,
      })).filter((g) => g.items.length > 0)
    )
  }, [filtered, source, tab])

  // Children under their parents within each group, except where the order
  // is the point: Recent is by time, and a finished child belongs where it
  // finished.
  const flat = tab === 'recent' || tab === 'closed'
  const rows = useMemo(
    () =>
      groups.map((g) => ({
        ...g,
        rows: flat ? g.items.map((task) => ({ task, depth: 0, nested: 0 })) : nestTasks(g.items, folded),
      })),
    [groups, flat, folded],
  )

  // The rows in display order, which is what a shift-click range means.
  const ordered = useMemo(() => rows.flatMap((g) => g.rows.map((r) => r.task.id)), [rows])

  const onToggle = (id: string, shiftKey: boolean) => {
    // Read the anchor BEFORE moving it. A state updater runs when React
    // processes the update, not when it is queued — so reading
    // `lastPicked.current` inside the updater saw the row just clicked, the
    // `anchor !== id` guard rejected it, and every shift-click quietly
    // degraded to a plain toggle. The pure function was right the whole time;
    // the wiring was not, which is why unit tests could not see it.
    const anchor = lastPicked.current
    lastPicked.current = id
    setSelected((prev) => applySelection(prev, ordered, id, { shiftKey, anchor }))
  }

  const toggle = (status: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })

  const { track: tabTrack, pill: tabPill } = useSlidingPill(tab)

  // `relative` so each label paints above the absolutely placed pill.
  const tabButton = (t: Tab, label: string) => (
    <button
      type="button"
      data-pill={t}
      onClick={() => setTab(t)}
      className={cn(
        'relative shrink-0 rounded-md px-2.5 py-1 text-meta whitespace-nowrap',
        'transition-colors duration-[var(--dur-2)] ease-[var(--ease-out)]',
        tab === t
          ? 'bg-surface-raised text-fg group-data-[measured]/tabs:bg-transparent'
          : 'text-fg-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  )

  return (
    <div>
      {/* Two rows on a phone, one on a desktop. Five tabs plus a filter plus a
          button does not fit in 390px, and cramming them ran the filter off
          the right edge. */}
      <div className="border-border flex flex-col gap-1.5 border-b px-3 py-2 sm:flex-row sm:items-center sm:gap-1">
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {toolbarExtra}
          {toolbarExtra ? <span className="bg-border mx-1 h-[1rem] w-px shrink-0" aria-hidden /> : null}
          <div ref={tabTrack} className="group/tabs relative flex shrink-0 items-center gap-1">
            <span ref={tabPill} aria-hidden className={PILL_CLASS} />
            {tabButton('doing', 'In Progress')}
            {tabButton('todo', 'Todo')}
            {tabButton('active', 'Active')}
            {tabButton('backlog', 'Backlog')}
            {tabButton('all', 'All')}
            {tabButton('recent', 'Recent')}
            {recentlyClosed.length > 0 && tabButton('closed', 'Recently closed')}
            {tasks.some((t) => t.claimed_by) && tabButton('held', 'Held')}
          </div>
        </div>

        {/* Outside the scrolling tab strip on purpose: a popover inside an
            overflow container is clipped (src/lib/overflow-guard.test.ts). */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <AssigneeFilter filter={assignees} tasks={tasks} />
          <input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter tasks"
            className="placeholder:text-fg-subtle border-border focus:border-accent min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-meta outline-none transition-colors sm:border-transparent sm:px-1 sm:py-0"
          />
          <span className="text-fg-subtle tabular shrink-0 text-meta">{filtered.length}</span>
          <NewTaskButton />
        </div>
      </div>

      {groups.length === 0 &&
        /**
         * "Nothing here" was fine when the page opened on All, where an empty
         * list meant an empty project. In Progress is the default now, so an
         * empty list is the ordinary state of a day where nothing has been
         * picked up — and a dead end is the wrong thing to show somebody who
         * has just arrived looking for work.
         */
        (query ? (
          <EmptyState title={`Nothing matches “${query}”.`} />
        ) : assignees.selected.length > 0 && source.length === 0 && pool.length > 0 ? (
          // The default shows only your own work, so on a team instance an
          // empty list usually means "nothing of yours", not "nothing".
          <EmptyState
            title={
              assignees.selected.length === 1 && assignees.selected[0] === assignees.me
                ? 'Nothing here is assigned to you.'
                : 'Nothing here is assigned to them.'
            }
            action={
              <button
                type="button"
                onClick={() => assignees.setSelected([])}
                className="text-accent text-ui hover:underline"
              >
                Show everyone’s
              </button>
            }
          />
        ) : tab === 'doing' ? (
          <EmptyState
            title="Nothing is in progress."
            action={
              <span className="text-fg-subtle flex items-center gap-1.5 text-ui">
                <button type="button" onClick={() => setTab('todo')} className="text-accent hover:underline">
                  Todo
                </button>
                <span aria-hidden>·</span>
                <button type="button" onClick={() => setTab('backlog')} className="text-accent hover:underline">
                  Backlog
                </button>
                <span aria-hidden>·</span>
                <button type="button" onClick={() => setTab('all')} className="text-accent hover:underline">
                  All
                </button>
              </span>
            }
          />
        ) : (
          <EmptyState title="Nothing here." />
        ))}

      {rows.map((group) => {
        const isCollapsed = collapsed.has(group.status)
        return (
          <section key={group.status}>
            <button
              type="button"
              onClick={() => toggle(group.status)}
              // z-20, not z-10: the row's priority cell is also z-10 and comes
              // later in the DOM, so it won the tie and painted straight through
              // the sticky heading — a bar-chart glyph and a type pill floating
              // over "In Progress". Same stacking context, equal z, DOM order
              // decides. Still beneath the bulk bar (z-40) and dialogs (z-50).
              //
              // A band, not a slab: translucent over the rows scrolling under
              // it, with a wash of the group's own colour from the left.
              className="group-band border-border hover:bg-surface-hover/70 sticky top-0 z-20 flex h-[2.125rem] w-full items-center gap-2 border-b px-3 text-left transition-colors duration-[var(--dur-1)] ease-[var(--ease)]"
              style={
                group.status === 'recent'
                  ? undefined
                  : ({ '--band': `var(--status-${group.status})` } as React.CSSProperties)
              }
            >
              {group.status === 'recent' ? (
                <Clock size={13} className="text-fg-subtle" />
              ) : (
                <StatusIcon status={group.status} size={13} />
              )}
              {/* The heading takes its status colour. Six groups otherwise read
                  as six identical grey rings above six identical grey words,
                  and the eye has nothing to land on when scrolling a long
                  list. */}
              <span
                className="text-meta font-medium"
                style={
                  group.status === 'recent'
                    ? undefined
                    : { color: `var(--status-${group.status})` }
                }
              >
                {GROUP_LABEL[group.status]}
              </span>
              <span className="text-fg-subtle tabular rounded-full bg-[color-mix(in_oklab,var(--fg)_6%,transparent)] px-1.5 text-meta leading-[1.125rem]">
                {group.items.length}
                {group.items.length !== group.total ? ` / ${group.total}` : ''}
              </span>
              <Plus size={13} className="text-fg-subtle ml-auto opacity-0" aria-hidden />
            </button>

            {!isCollapsed && (
              <ul className={cn('divide-border divide-y', STAGGER)}>
                {group.rows.map(({ task, depth, nested }) => (
                  <li key={task.id}>
                    <Row
                      task={task}
                      projectKey={projectKey}
                      showProject={showProject}
                      selected={selected.has(task.id)}
                      selecting={selected.size > 0}
                      onToggle={onToggle}
                      knownLabels={knownLabels}
                      projects={projects}
                      depth={depth}
                      nested={nested}
                      childrenHidden={folded.has(task.id)}
                      onToggleChildren={toggleFolded}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      {selected.size > 0 && (
        <BulkBar
          ids={ordered.filter((id) => selected.has(id))}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  )
}
