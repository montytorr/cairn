'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { SearchX } from 'lucide-react'
import { ClaimChip, PriorityBadge, StatusBadge, TypeBadge } from '@/components/badges'
import { Input, Select } from '@/components/ui/control'
import { cn, isClaimStale } from '@/lib/utils'
import { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from '@/schemas/task'
import type { TaskListItem } from '@/lib/data'

type GroupBy = 'status' | 'type' | 'priority' | 'none'

/**
 * The dense view, and the default. Scanning for one thing among hundreds is
 * the common case; moving cards around is not.
 *
 * Hierarchy is deliberate and was cut back hard. Every row previously carried
 * priority, ref, type, status, title, imported ref, labels and a claim chip —
 * eight things competing, so nothing led. What survives at a glance:
 *
 *   1. priority   a 3px shape in the left margin, read as a column not a word
 *   2. title      the only full-contrast text on the row
 *   3. state      one icon, colour-coded, and only when it is not the group
 *
 * Everything else is demoted to muted, right-aligned metadata that the eye
 * skips unless it is looking for it. Labels moved to the detail view.
 */
export const ListView = ({
  tasks,
  projectKey,
}: {
  tasks: TaskListItem[]
  projectKey: string
}) => {
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [status, setStatus] = useState<TaskStatus | 'all'>('all')
  const [type, setType] = useState<TaskType | 'all'>('all')
  const [query, setQuery] = useState('')

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (status !== 'all' && t.status !== status) return false
        if (type !== 'all' && t.type !== type) return false
        if (query) {
          const haystack =
            `${t.title} ${t.preview ?? ''} ${t.labels.join(' ')} ${t.external_ref ?? ''}`.toLowerCase()
          if (!haystack.includes(query.toLowerCase())) return false
        }
        return true
      }),
    [tasks, status, type, query],
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by title, body or ref…"
          className="min-w-48 flex-1"
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
        <span className="text-fg-subtle tabular ml-auto text-[11px]">
          {filtered.length === tasks.length ? `${tasks.length}` : `${filtered.length} of ${tasks.length}`}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-2 rounded-md border border-dashed py-16">
          <SearchX size={18} className="text-fg-subtle" strokeWidth={1.5} />
          <p className="text-fg-muted text-[13px]">Nothing matches that filter.</p>
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-accent text-[11px] hover:underline"
            >
              Clear “{query}”
            </button>
          ) : null}
        </div>
      ) : null}

      {groups.map((group, groupIndex) => (
        <section key={group.key} className="mb-6 last:mb-0">
          {groupBy !== 'none' && (
            <div className="mb-1.5 flex items-baseline gap-2 px-1">
              <h3 className="text-fg-muted text-[11px] font-medium tracking-wide uppercase">
                {group.key}
              </h3>
              <span className="text-fg-subtle tabular text-[11px]">{group.items.length}</span>
              <span className="bg-border ml-1 h-px flex-1" />
            </div>
          )}

          <ul className="border-border divide-border overflow-hidden rounded-md border divide-y">
            {group.items.map((task, i) => (
              <li
                key={task.id}
                className="settle"
                // Capped so a long list settles in a beat, not a slideshow.
                style={{ animationDelay: `${Math.min((groupIndex * 4 + i) * 12, 260)}ms` }}
              >
                <Link
                  href={`/projects/${projectKey}/tasks/${task.number}`}
                  className={cn(
                    'group flex h-row items-center gap-2.5 pr-3 pl-2 transition-colors duration-100',
                    'hover:bg-surface-raised',
                  )}
                >
                  <span className="flex w-3 shrink-0 justify-center">
                    <PriorityBadge priority={task.priority} />
                  </span>

                  {groupBy !== 'status' && <StatusBadge status={task.status} compact />}

                  <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>

                  {task.claimed_by ? (
                    <ClaimChip by={task.claimed_by} stale={isClaimStale(task.heartbeat_at)} />
                  ) : null}

                  {task.has_resolution ? (
                    <span
                      className="bg-status-done size-1.5 shrink-0 rounded-full"
                      title="has a recorded resolution"
                    />
                  ) : null}

                  {groupBy !== 'type' && (
                    <span className="hidden shrink-0 sm:block">
                      <TypeBadge type={task.type} compact />
                    </span>
                  )}

                  <code className="text-fg-subtle hidden shrink-0 text-[10.5px] md:block">
                    {task.external_ref ?? `${projectKey}-${task.number}`}
                  </code>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
