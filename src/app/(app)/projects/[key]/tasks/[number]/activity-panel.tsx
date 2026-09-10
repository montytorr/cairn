'use client'

import { useState } from 'react'
import { Avatar, StatusIcon } from '@/components/icons'
import type { TaskStatus } from '@/schemas/task'
import type { ActivityEntry } from '@/lib/data'

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const when = (iso: string) => {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const val = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

/**
 * One line per event, phrased as a sentence rather than rendered as a
 * field/old/new table — a history is read, not queried.
 */
const describe = (entry: ActivityEntry): React.ReactNode => {
  const d = (entry.data ?? {}) as Record<string, unknown>
  switch (entry.event) {
    case 'created':
      return <>filed it{d.type ? <> as a {String(d.type)}</> : null}</>
    case 'status_changed':
      return (
        <span className="inline-flex items-center gap-1.5">
          moved it to
          <StatusIcon status={String(d.to) as TaskStatus} size={12} />
          {STATUS_LABEL[String(d.to)] ?? String(d.to)}
          <span className="text-fg-subtle">from {STATUS_LABEL[String(d.from)] ?? val(d.from)}</span>
        </span>
      )
    case 'priority_changed':
      return <>set priority to {val(d.to)} <span className="text-fg-subtle">from {val(d.from)}</span></>
    case 'type_changed':
      return <>changed the type to {val(d.to)} <span className="text-fg-subtle">from {val(d.from)}</span></>
    case 'renamed':
      return <>renamed it <span className="text-fg-subtle">from “{val(d.from)}”</span></>
    case 'labels_changed':
      return <>set the labels to {Array.isArray(d.to) && d.to.length ? d.to.join(', ') : 'none'}</>
    case 'due_date_changed':
      return d.to ? <>set the due date to {val(d.to)}</> : <>cleared the due date</>
    case 'body_edited':
      return <>edited the body</>
    case 'resolved':
      return <>recorded a resolution{d.kind ? <> · {String(d.kind)}</> : null}</>
    case 'resolution_revised':
      return <>revised the resolution</>
    case 'marked_duplicate':
      return <>marked it a duplicate</>
    case 'duplicate_cleared':
      return <>removed the duplicate pointer</>
    case 'claimed':
      return (
        <>
          claimed it{typeof d.attempt === 'number' && d.attempt > 1 ? <> (attempt {d.attempt})</> : null}
        </>
      )
    case 'released':
      return d.reason === 'closed' ? <>released it on close</> : <>released it</>
    case 'blocked':
      return <>marked it blocked{d.reason ? <>: {String(d.reason)}</> : null}</>
    case 'unblocked':
      return <>unblocked it</>
    default:
      return <>{entry.event.replace(/_/g, ' ')}</>
  }
}

/**
 * Collapsed by default. This answers "why is it like this?", which is a
 * question people ask occasionally and never on first read — putting it open
 * would push the comments below the fold for no one's benefit.
 */
export const ActivityPanel = ({ entries }: { entries: ActivityEntry[] }) => {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null

  return (
    <section className="border-border border-t pt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-fg-subtle hover:text-fg flex items-center gap-1.5 text-[11px] font-medium transition-colors"
        aria-expanded={open}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 9 9"
          aria-hidden
          style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
        >
          <path d="M3 1.5L6 4.5 3 7.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
        Activity · {entries.length}
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-2 text-[12.5px]">
              <Avatar name={e.actor_id} size={16} />
              <span className="text-fg-muted min-w-0 flex-1">
                <span className="text-fg">{e.actor_id}</span> {describe(e)}
              </span>
              <time
                dateTime={e.created_at}
                title={new Date(e.created_at).toLocaleString('en-GB')}
                className="text-fg-subtle shrink-0 text-[11px]"
              >
                {when(e.created_at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
