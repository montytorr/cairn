'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Plus } from 'lucide-react'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { cn, isClaimStale } from '@/lib/utils'
import { TASK_STATUSES, type TaskStatus } from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'
import { NewTaskButton } from '@/components/task-creation'

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

/** `Sep 10` — Linear shows a short date, never a timestamp, in a list. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

const Row = ({
  task,
  projectKey,
  showProject,
}: {
  task: TaskListItem & { project_key?: string }
  projectKey: string
  showProject?: boolean
}) => (
  <Link
    href={`/projects/${task.project_key ?? projectKey}/tasks/${task.number}`}
    // A 300-row list is mostly out of view, so Next's viewport prefetch does
    // not help. Prefetching on hover is what makes the click feel instant.
    prefetch
    className="group hover:bg-surface-hover flex h-[36px] items-center gap-2 pr-4 pl-3 transition-colors duration-75"
  >
    <PriorityIcon priority={task.priority} />

    <code className="text-fg-subtle w-[72px] shrink-0 truncate text-[12px] tabular">
      {task.external_ref ?? `${task.project_key ?? projectKey}-${task.number}`}
    </code>

    <StatusIcon status={task.status} />

    <span className="text-fg min-w-0 flex-1 truncate text-[13px]">{task.title}</span>

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

    {showProject ? (
      <span className="text-fg-muted hidden shrink-0 items-center gap-1.5 text-[12px] md:flex">
        <ProjectIcon size={12} />
        {task.project_key}
      </span>
    ) : null}

    <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
      {task.labels.slice(0, 2).map((l) => (
        <LabelPill key={l}>{l}</LabelPill>
      ))}
      <TypePill type={task.type} />
    </span>

    {task.claimed_by ? (
      <span
        className={cn('shrink-0', isClaimStale(task.heartbeat_at) && 'opacity-40')}
        title={
          isClaimStale(task.heartbeat_at)
            ? `${task.claimed_by} holds this but has gone quiet`
            : `Held by ${task.claimed_by}`
        }
      >
        <Avatar name={task.claimed_by} size={18} />
      </span>
    ) : (
      <span className="border-border hidden size-[18px] shrink-0 rounded-full border border-dashed sm:block" />
    )}

    <span className="text-fg-subtle tabular hidden w-[46px] shrink-0 text-right text-[12px] md:block">
      {shortDate(task.updated_at)}
    </span>
  </Link>
)

export const ListView = ({
  tasks,
  projectKey,
  showProject,
}: {
  tasks: (TaskListItem & { project_key?: string })[]
  projectKey: string
  showProject?: boolean
}) => {
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const filterRef = useRef<HTMLInputElement>(null)

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

  const toggle = (status: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })

  const tabClass = (t: Tab) =>
    cn(
      'rounded-md px-2.5 py-1 text-[12px] transition-colors',
      tab === t ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg',
    )

  return (
    <div>
      <div className="border-border flex items-center gap-1 border-b px-3 py-2">
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
        <input
          ref={filterRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…   /"
          aria-label="Filter tasks"
          className="placeholder:text-fg-subtle ml-2 min-w-32 flex-1 bg-transparent px-1 text-[12px] outline-none"
        />
        <span className="text-fg-subtle tabular text-[11px]">{filtered.length}</span>
        <NewTaskButton />
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
                    <Row task={task} projectKey={projectKey} showProject={showProject} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
