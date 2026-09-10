'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ClaimChip, Label, PriorityBadge, StatusBadge, TypeBadge } from '@/components/badges'
import { cn, isClaimStale } from '@/lib/utils'
import { Input, Select } from '@/components/ui/control'
import { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'

type GroupBy = 'status' | 'type' | 'priority' | 'none'

/**
 * The dense view. For a personal tracker this usually beats the board — you
 * are scanning for one thing, not moving cards around.
 */
export const ListView = ({ tasks, projectKey }: { tasks: TaskListItem[]; projectKey: string }) => {
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [status, setStatus] = useState<TaskStatus | 'all'>('all')
  const [type, setType] = useState<TaskType | 'all'>('all')
  const [query, setQuery] = useState('')
  const [showClosed, setShowClosed] = useState(true)

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (status !== 'all' && t.status !== status) return false
        if (type !== 'all' && t.type !== type) return false
        if (!showClosed && (t.status === 'done' || t.status === 'cancelled')) return false
        if (query) {
          const haystack = `${t.title} ${t.preview ?? ''} ${t.labels.join(' ')}`.toLowerCase()
          if (!haystack.includes(query.toLowerCase())) return false
        }
        return true
      }),
    [tasks, status, type, query, showClosed],
  )

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'All', items: filtered }]
    const order =
      groupBy === 'status'
        ? [...TASK_STATUSES]
        : groupBy === 'type'
          ? [...TASK_TYPES]
          : ['urgent', 'high', 'medium', 'low']
    return order
      .map((key) => ({
        key,
        items: filtered.filter((t) => (t as unknown as Record<string, string>)[groupBy] === key),
      }))
      .filter((g) => g.items.length > 0)
  }, [filtered, groupBy])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          className="min-w-40 flex-1"
        />
        <Select
          size="sm"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="w-36"
          aria-label="Group by"
        >
          <option value="status">Group: status</option>
          <option value="type">Group: type</option>
          <option value="priority">Group: priority</option>
          <option value="none">No grouping</option>
        </Select>
        <Select
          size="sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskStatus | 'all')}
          className="w-32"
          aria-label="Status"
        >
          <option value="all">Any status</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
        <Select
          size="sm"
          value={type}
          onChange={(e) => setType(e.target.value as TaskType | 'all')}
          className="w-32"
          aria-label="Type"
        >
          <option value="all">Any type</option>
          {TASK_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
        <label className="text-fg-muted flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-accent" />
          closed
        </label>
        <span className="text-fg-subtle tabular ml-auto text-xs">{filtered.length} of {tasks.length}</span>
      </div>

      {groups.length === 0 && (
        <p className="text-fg-subtle py-8 text-center text-sm">Nothing matches.</p>
      )}

      {groups.map((group) => (
        <section key={group.key} className="mb-5">
          {groupBy !== 'none' && (
            <h3 className="text-fg-subtle mb-1 flex items-center gap-2 px-0.5 text-[11px] font-medium uppercase">
              {group.key}
              <span className="tabular">{group.items.length}</span>
            </h3>
          )}
          <ul className="divide-border border-border divide-y overflow-hidden rounded-md border">
            {group.items.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/projects/${projectKey}/tasks/${task.number}`}
                  className="hover:bg-surface-raised flex items-center gap-2.5 px-3 py-2 transition-colors"
                >
                  <PriorityBadge priority={task.priority} />
                  <code className="text-fg-subtle w-16 shrink-0 text-[11px]">
                    {projectKey}-{task.number}
                  </code>
                  <TypeBadge type={task.type} compact />
                  {groupBy !== 'status' && <StatusBadge status={task.status} compact />}
                  <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                  {task.external_ref && (
                    <span
                      className="text-fg-subtle hidden shrink-0 text-[10px] sm:inline"
                      title={`imported from Linear ${task.external_ref}`}
                    >
                      {task.external_ref}
                    </span>
                  )}
                  {task.has_resolution && (
                    <span className="text-status-done shrink-0 text-[11px]">answered</span>
                  )}
                  {task.labels.slice(0, 2).map((l) => (
                    <Label key={l}>{l}</Label>
                  ))}
                  {task.claimed_by && (
                    <ClaimChip by={task.claimed_by} stale={isClaimStale(task.heartbeat_at)} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
