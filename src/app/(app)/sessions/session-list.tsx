'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, FileText, ListChecks } from 'lucide-react'
import { Avatar, ProjectIcon } from '@/components/icons'
import { MarkdownView } from '@/components/markdown'
import { timeOfDay } from '@/lib/dates'
import { cn, taskRefHref } from '@/lib/utils'
import type { DayGroup } from '@/lib/session-grouping'

export type SessionItem = {
  id: string
  endedAt: string | null
  agent: string | null
  platform: string
  project: string | null
  request: string | null
  learned: string | null
  completed: string | null
  nextSteps: string | null
  files: string[]
  taskRefs: string[]
}

const Prose = ({ label, body }: { label: string; body: string | null }) => {
  if (!body) return null
  return (
    <div>
      <h3 className="text-fg-subtle mb-1 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </h3>
      <MarkdownView>{body}</MarkdownView>
    </div>
  )
}

const Row = ({ item }: { item: SessionItem }) => {
  const [open, setOpen] = useState(false)
  const agentName = item.agent ?? 'unknown agent'

  return (
    <li className="border-border border-b last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:bg-surface-hover flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors sm:px-4"
      >
        <ChevronRight
          size={13}
          className={cn('text-fg-subtle shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span className="text-fg-subtle tabular w-[42px] shrink-0 text-[12px]">
          {item.endedAt ? timeOfDay(item.endedAt) : '—'}
        </span>
        <Avatar name={agentName} size={18} />
        {item.project && (
          <span className="text-fg-muted hidden shrink-0 items-center gap-1 text-[12px] sm:flex">
            <ProjectIcon size={11} projectKey={item.project} />
            {item.project}
          </span>
        )}
        <span className="text-fg min-w-0 flex-1 truncate text-[13px]">
          {item.request ?? <span className="text-fg-subtle italic">No request recorded.</span>}
        </span>
        <span className="text-fg-subtle flex shrink-0 items-center gap-2.5 text-[11px]">
          {item.files.length > 0 && (
            <span className="inline-flex items-center gap-1" title={`${item.files.length} files touched`}>
              <FileText size={11} aria-hidden />
              {item.files.length}
            </span>
          )}
          {item.taskRefs.length > 0 && (
            <span className="inline-flex items-center gap-1" title={`${item.taskRefs.length} task refs`}>
              <ListChecks size={11} aria-hidden />
              {item.taskRefs.length}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-border bg-surface-raised flex flex-col gap-4 border-t px-4 py-3 pl-[76px] sm:pl-[84px]">
          <Prose label="Learned" body={item.learned} />
          <Prose label="Completed" body={item.completed} />
          <Prose label="Next steps" body={item.nextSteps} />

          {item.taskRefs.length > 0 && (
            <div>
              <h3 className="text-fg-subtle mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                Tasks
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {item.taskRefs.map((ref) => {
                  const href = taskRefHref(ref)
                  return href ? (
                    <Link
                      key={ref}
                      href={href}
                      prefetch
                      className="border-border text-fg-muted hover:border-accent hover:text-accent rounded-full border px-2 py-0.5 text-[11px] transition-colors"
                    >
                      {ref}
                    </Link>
                  ) : (
                    <span
                      key={ref}
                      className="border-border text-fg-subtle rounded-full border px-2 py-0.5 text-[11px]"
                    >
                      {ref}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {item.files.length > 0 && (
            <div>
              <h3 className="text-fg-subtle mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                Files ({item.files.length})
              </h3>
              <div className="border-border bg-bg max-h-[180px] overflow-y-auto rounded-md border">
                <ul className="divide-border divide-y">
                  {item.files.map((f) => (
                    <li key={f} className="text-fg-muted truncate px-2.5 py-1 font-mono text-[11.5px]">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export const SessionTimeline = ({ groups }: { groups: DayGroup<SessionItem>[] }) => (
  <div>
    {groups.map((group) => (
      <section key={group.day}>
        <div className="bg-bg-elevated border-border sticky top-0 z-10 flex h-[30px] items-center border-b px-3 sm:px-4">
          <span className="text-fg-muted text-[12px] font-medium">{group.day}</span>
        </div>
        <ul>
          {group.rows.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      </section>
    ))}
  </div>
)
