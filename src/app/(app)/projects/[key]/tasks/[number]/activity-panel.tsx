'use client'

import { useState } from 'react'
import { Avatar, StatusIcon } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import type { TaskStatus } from '@/schemas/task'
import type { ActivityEntry } from '@/lib/data'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
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
    case 'assignee_changed':
      return d.to_name ? (
        <>
          assigned this to {String(d.to_name)}
          {d.from_name ? <span className="text-fg-subtle"> from {String(d.from_name)}</span> : null}
        </>
      ) : (
        <>reassigned this</>
      )
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
      return d.reason === 'closed' ? (
        <>released it on close</>
      ) : (
        <>
          released it{d.reason === 'reconcile' ? <> after it went quiet</> : null}
          {d.reopened ? <>, back to todo</> : null}
        </>
      )
    case 'blocked':
      return <>marked it blocked{d.reason ? <>: {String(d.reason)}</> : null}</>
    case 'unblocked':
      return <>unblocked it</>
    case 'git_commit':
      return <>recorded commit <code className="font-mono text-meta">{val(d.sha)}</code>{d.message ? <> · {String(d.message)}</> : null}</>
    case 'git_push':
      return <>pushed <code className="font-mono text-meta">{val(d.sha)}</code>{d.branch ? <> to {String(d.branch)}</> : null}</>
    case 'checkpointed':
      return <>checkpointed{d.summary ? <>: {String(d.summary)}</> : null}</>
    case 'auto_checkpointed':
      return <>checkpointed it automatically at session end{d.worked ? null : <> (held, not worked)</>}</>
    case 'attachment_added':
      return <>attached <code className="font-mono text-meta">{val(d.name)}</code></>
    case 'attachment_removed':
      return <>removed the attachment <code className="font-mono text-meta">{val(d.name)}</code></>
    case 'dependency_added':
      return (
        <>
          made it {d.direction === 'blocking' ? 'block' : 'depend on'}{' '}
          <code className="font-mono text-meta">{val(d.other ?? d.ref)}</code>
        </>
      )
    case 'dependency_removed':
      return (
        <>
          unlinked <code className="font-mono text-meta">{val(d.other ?? d.ref)}</code>
        </>
      )
    case 'task_deleted':
      return <>deleted <code className="font-mono text-meta">{val(d.ref)}</code></>
    case 'run_result':
      return <>{val(d.status)} <code className="font-mono text-meta">{val(d.command)}</code>{d.exitCode !== undefined ? <> · exit {String(d.exitCode)}</> : null}</>
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
  // Mounted on first open and kept, so the rows are there to unfold into —
  // and a long history costs nothing on a page where nobody opens it.
  const [seen, setSeen] = useState(false)
  if (entries.length === 0) return null

  return (
    <section>
      <button
        type="button"
        onClick={() => {
          setSeen(true)
          setOpen((o) => !o)
        }}
        className={cn(LABEL, 'hover:text-fg flex items-center gap-1.5 transition-colors duration-[var(--dur-1)]')}
        aria-expanded={open}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 9 9"
          aria-hidden
          className={cn(
            'transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)]',
            open && 'rotate-90',
          )}
        >
          <path d="M3 1.5L6 4.5 3 7.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
        Activity
        <span className={COUNT}>{entries.length}</span>
      </button>

      {/* Unfolds rather than appears: the row track goes from 0fr to 1fr,
          which animates the height without animating a height. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)]',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {seen ? (
            <ol className="mt-2.5 flex flex-col gap-1">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="row-hover -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-0.5 text-ui"
                >
                  <Avatar name={e.actor_id} size={16} />
                  <span className="text-fg-muted min-w-0 flex-1">
                    <span className="text-fg">{e.actor_id}</span> {describe(e)}
                  </span>
                  <RelativeTime iso={e.created_at} className="text-fg-subtle shrink-0 text-meta" />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </section>
  )
}
