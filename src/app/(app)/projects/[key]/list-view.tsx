'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Plus } from 'lucide-react'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { cn } from '@/lib/utils'
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

type Tab = 'active' | 'backlog' | 'all' | 'recent' | 'held'

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const Row = ({
  task,
  projectKey,
  showProject,
  selected,
  selecting,
  onToggle,
  knownLabels,
  projects,
}: {
  task: TaskListItem & { project_key?: string; guest?: boolean }
  projectKey: string
  showProject?: boolean
  selected: boolean
  selecting: boolean
  onToggle: (id: string, shiftKey: boolean) => void
  knownLabels: string[]
  projects: { key: string; title: string }[]
}) => {
  const stale = useRenderedClaimStale(task.heartbeat_at)
  const ownKey = task.project_key ?? projectKey
  const ref = `${ownKey}-${task.number}`
  const { patch, overlay, error, clearError } = useQuickPatch(ref, task.updated_at)
  const [closing, setClosing] = useState<TaskStatus | null>(null)

  // The optimistic overlay wins until the refreshed row arrives.
  const status = (overlay?.status as TaskStatus) ?? task.status
  const priority = (overlay?.priority as TaskPriority) ?? task.priority
  const type = (overlay?.type as TaskType) ?? task.type
  const labels = (overlay?.labels as string[]) ?? task.labels

  return (
    <div
      className={cn(
        'group relative flex h-[36px] items-center transition-colors duration-75',
        // Shift-click paints a text selection across the rows it passes
        // otherwise, which looks like a mistake on every range.
        'select-none',
        selected ? 'bg-accent-subtle' : 'hover:bg-surface-hover',
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
          'relative z-10 grid h-[36px] w-[30px] shrink-0 place-items-center pl-3 transition-opacity',
          selected || selecting
            ? 'opacity-100'
            : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
        )}
      >
        <span
          className={cn(
            'grid size-[14px] place-items-center rounded-[4px] border transition-colors',
            selected
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-border-strong bg-surface hover:border-accent',
          )}
        >
          {selected && (
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
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

      <div className="pointer-events-none flex h-[36px] min-w-0 flex-1 items-center gap-2 pl-1.5 pr-3 md:pr-4">
        <QuickSelect
          value={priority}
          options={TASK_PRIORITIES}
          title={`Priority: ${priority}`}
          onChange={(next) => void patch({ priority: next })}
          className="pointer-events-auto"
        >
          <PriorityIcon priority={priority} />
        </QuickSelect>

        <code className="text-fg-subtle hidden w-[62px] shrink-0 truncate text-[12px] tabular sm:block md:w-[72px]">
          {task.external_ref ?? ref}
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

        <span className="text-fg min-w-0 flex-1 truncate text-[13px]">{task.title}</span>

        {/* Filed in another project and linked here. Without saying so, a row
            reading CAIRN-83 in the HM list reads as a bug rather than as work
            that genuinely spans both. */}
        {task.guest && (
          <span
            title={`Filed in ${ownKey}, also belongs here`}
            className="border-border text-fg-subtle pointer-events-auto hidden shrink-0 rounded border px-1.5 py-px text-[10px] tracking-wide uppercase sm:inline"
          >
            guest
          </span>
        )}

        {error ? (
          <button
            type="button"
            onClick={clearError}
            title={error}
            className="text-danger pointer-events-auto shrink-0 text-[11px]"
          >
            refused
          </button>
        ) : null}

        {task.blocked_reason ? (
          <span
            className="text-danger shrink-0 text-[11px]"
            title={`Blocked: ${task.blocked_reason}`}
          >
            blocked
          </span>
        ) : null}

        {task.has_resolution ? (
          <span
            className="bg-status-done size-[6px] shrink-0 rounded-full"
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
            className="text-fg-muted pointer-events-auto hidden items-center gap-1.5 text-[12px] md:inline-flex"
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

        {task.claimed_by ? (
          <span
            className={cn('shrink-0', stale && 'opacity-40')}
            title={
              stale
                ? `${task.claimed_by} holds this but has gone quiet`
                : `Held by ${task.claimed_by}`
            }
          >
            <Avatar name={task.claimed_by} size={18} />
          </span>
        ) : (
          <span className="border-border hidden size-[18px] shrink-0 rounded-full border border-dashed sm:block" />
        )}

        <time
          dateTime={task.updated_at}
          title={fullDateTime(task.updated_at)}
          className="text-fg-subtle tabular hidden w-[46px] shrink-0 text-right text-[12px] md:block"
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
  projectKey,
  showProject,
  projects = [],
  toolbarExtra,
}: {
  tasks: (TaskListItem & { project_key?: string })[]
  projectKey: string
  showProject?: boolean
  /** Offered when a row shows its project, so it can be moved from the list. */
  projects?: { key: string; title: string }[]
  /** The view toggle, so it does not need a band of its own above the list. */
  toolbarExtra?: React.ReactNode
}) => {
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
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
      if (e.key === '1') setTab('active')
      if (e.key === '2') setTab('backlog')
      if (e.key === '3') setTab('all')
      if (e.key === '4') setTab('recent')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    const byTab = tasks.filter((t) => {
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
  }, [tasks, tab, query])

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
        total: tasks.filter((t) => t.status === status).length,
      })).filter((g) => g.items.length > 0)
    )
  }, [filtered, tasks, tab])

  // The rows in display order, which is what a shift-click range means.
  const ordered = useMemo(() => groups.flatMap((g) => g.items.map((t) => t.id)), [groups])

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

  const tabClass = (t: Tab) =>
    cn(
      'shrink-0 rounded-md px-2.5 py-1 text-[12px] whitespace-nowrap transition-colors',
      tab === t ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg',
    )

  return (
    <div>
      {/* Two rows on a phone, one on a desktop. Five tabs plus a filter plus a
          button does not fit in 390px, and cramming them ran the filter off
          the right edge. */}
      <div className="border-border flex flex-col gap-1.5 border-b px-3 py-2 sm:flex-row sm:items-center sm:gap-1">
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {toolbarExtra}
          {toolbarExtra ? <span className="bg-border mx-1 h-[16px] w-px shrink-0" aria-hidden /> : null}
          <button type="button" onClick={() => setTab('active')} className={tabClass('active')}>
            Active
          </button>
          <button type="button" onClick={() => setTab('backlog')} className={tabClass('backlog')}>
            Backlog
          </button>
          <button type="button" onClick={() => setTab('all')} className={tabClass('all')}>
            All
          </button>
          <button type="button" onClick={() => setTab('recent')} className={tabClass('recent')}>
            Recent
          </button>
          {tasks.some((t) => t.claimed_by) && (
            <button type="button" onClick={() => setTab('held')} className={tabClass('held')}>
              Held
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter tasks"
            className="placeholder:text-fg-subtle border-border focus:border-accent min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-[12px] outline-none transition-colors sm:border-transparent sm:px-1 sm:py-0"
          />
          <span className="text-fg-subtle tabular shrink-0 text-[11px]">{filtered.length}</span>
          <NewTaskButton />
        </div>
      </div>

      {groups.length === 0 && (
        <p className="text-fg-subtle py-16 text-center text-[13px]">Nothing here.</p>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.status)
        return (
          <section key={group.status}>
            <button
              type="button"
              onClick={() => toggle(group.status)}
              className="bg-bg-elevated border-border hover:bg-surface-hover sticky top-0 z-10 flex h-[34px] w-full items-center gap-2 border-b px-3 text-left transition-colors"
            >
              {group.status === 'recent' ? (
                <Clock size={13} className="text-fg-subtle" />
              ) : (
                <StatusIcon status={group.status} size={13} />
              )}
              <span className="text-fg text-[12px] font-medium">
                {GROUP_LABEL[group.status]}
              </span>
              <span className="text-fg-subtle tabular text-[12px]">
                {group.items.length}
                {group.items.length !== group.total ? ` / ${group.total}` : ''}
              </span>
              <Plus size={13} className="text-fg-subtle ml-auto opacity-0" aria-hidden />
            </button>

            {!isCollapsed && (
              <ul className="divide-border divide-y">
                {group.items.map((task) => (
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
