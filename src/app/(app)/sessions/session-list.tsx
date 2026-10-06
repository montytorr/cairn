'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, FileText, ListChecks } from 'lucide-react'
import { Avatar, ProjectIcon } from '@/components/icons'
import { MarkdownView } from '@/components/markdown'
import { timeOfDay } from '@/lib/dates'
import { sessionTitle } from '@/lib/session-title'
import { cn, taskRefHref } from '@/lib/utils'
import type { DayGroup } from '@/lib/session-grouping'

export type SessionItem = {
  id: string
  endedAt: string | null
  agent: string | null
  platform: string
  project: string | null
  request: string | null
  scheduled: boolean
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
      <h3 className="text-fg-subtle mb-1 text-label font-medium tracking-wide uppercase">
        {label}
      </h3>
      <MarkdownView>{body}</MarkdownView>
    </div>
  )
}

/** A count on the right of a row: present, legible, and never louder than the title. */
const Count = ({ icon, n, title }: { icon: React.ReactNode; n: number; title: string }) => (
  <span
    className="border-border bg-surface text-fg-subtle inline-flex h-[1.125rem] items-center gap-1 rounded-full border px-1.5 tabular-nums"
    title={title}
  >
    {icon}
    {n}
  </span>
)

const Row = ({ item }: { item: SessionItem }) => {
  const [open, setOpen] = useState(false)
  // Mounted on first open and kept, so closing can run the same transition
  // back rather than snapping shut; never opened, nothing is rendered.
  const [seen, setSeen] = useState(false)
  const agentName = item.agent ?? 'unknown agent'

  return (
    <li className="border-border/70 border-b last:border-0">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setSeen(true)
        }}
        aria-expanded={open}
        className={cn(
          'row-hover flex w-full items-center gap-2.5 px-3 py-2.5 text-left sm:px-4',
          open && 'bg-surface-hover/60',
        )}
      >
        <ChevronRight
          size={13}
          className={cn(
            'text-fg-subtle shrink-0 transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)]',
            open && 'text-fg-muted rotate-90',
          )}
          aria-hidden
        />
        <span className="text-fg-subtle w-[2.625rem] shrink-0 font-mono text-meta tabular-nums">
          {item.endedAt ? timeOfDay(item.endedAt) : '—'}
        </span>
        {/* A hairline ring so the initials disc reads as a crisp token on the
            dark ground rather than a soft blot. */}
        <span className="ring-border-strong inline-flex shrink-0 rounded-full ring-1">
          <Avatar name={agentName} size={18} />
        </span>
        {item.project && (
          <span className="text-fg-muted hidden shrink-0 items-center gap-1 text-meta sm:flex">
            <ProjectIcon size={11} projectKey={item.project} />
            {item.project}
          </span>
        )}
        {(() => {
          const { text, machine } = sessionTitle(item)
          return (
            <span
              className={cn(
                'min-w-0 flex-1 text-ui line-clamp-2 break-words sm:line-clamp-1',
                machine ? 'text-fg-muted' : 'text-fg',
              )}
              // The machine prompt is still what opened the session, so it stays
              // reachable rather than being hidden outright.
              title={machine ? (item.request ?? undefined) : undefined}
            >
              {text}
            </span>
          )
        })()}
        <span className="flex shrink-0 items-center gap-1.5 text-meta">
          {item.files.length > 0 && (
            <Count
              icon={<FileText size={10} aria-hidden />}
              n={item.files.length}
              title={`${item.files.length} files touched`}
            />
          )}
          {item.taskRefs.length > 0 && (
            <Count
              icon={<ListChecks size={10} aria-hidden />}
              n={item.taskRefs.length}
              title={`${item.taskRefs.length} task refs`}
            />
          )}
        </span>
      </button>

      {seen && (
        // 0fr → 1fr: the body opens to its own height without anything
        // measuring it. `starting:` covers the first open, where the element
        // is being inserted rather than changed. Closed, it is inert so the
        // links inside are not tab stops behind a collapsed row.
        <div
          inert={!open}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)] starting:grid-rows-[0fr] starting:opacity-0',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="px-3 pb-3 pl-[4.75rem] sm:px-4 sm:pl-[5.25rem]">
              <div className="surface-card flex flex-col gap-4 px-4 py-3">
                <Prose label="Learned" body={item.learned} />
                <Prose label="Completed" body={item.completed} />
                <Prose label="Next steps" body={item.nextSteps} />

                {item.taskRefs.length > 0 && (
                  <div>
                    <h3 className="text-fg-subtle mb-1.5 text-label font-medium tracking-wide uppercase">
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
                            className="border-border bg-surface text-fg-muted hover:border-accent hover:text-accent rounded-full border px-2 py-0.5 font-mono text-meta transition-[color,border-color] duration-[var(--dur-2)] ease-[var(--ease-out)]"
                          >
                            {ref}
                          </Link>
                        ) : (
                          <span
                            key={ref}
                            className="border-border text-fg-subtle rounded-full border px-2 py-0.5 font-mono text-meta"
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
                    <h3 className="text-fg-subtle mb-1.5 text-label font-medium tracking-wide uppercase">
                      Files <span className="tabular-nums">({item.files.length})</span>
                    </h3>
                    <div className="border-border bg-bg max-h-[11.25rem] overflow-y-auto rounded-md border">
                      <ul className="divide-border divide-y">
                        {item.files.map((f) => (
                          <li key={f} className="text-fg-muted truncate px-2.5 py-1 font-mono text-meta">
                            {f}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </li>
  )
}

export const SessionTimeline = ({ groups }: { groups: DayGroup<SessionItem>[] }) => (
  <div>
    {groups.map((group) => (
      <section key={group.day}>
        <div className="group-band border-border sticky top-0 z-10 flex h-[1.875rem] items-center border-b px-3 sm:px-4">
          <span className="text-fg-muted text-meta font-medium">{group.day}</span>
        </div>
        <ul className="stagger">
          {group.rows.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      </section>
    ))}
  </div>
)
