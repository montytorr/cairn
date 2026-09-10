'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PriorityIcon, StatusIcon } from '@/components/icons'
import { isTerminal } from '@/schemas/task'
import type { ChildTask } from '@/lib/data'

/**
 * Direct children, with a rollup.
 *
 * The bar counts *closed*, not `done` — a cancelled sub-task is decided, and
 * showing an epic as permanently incomplete because one piece was dropped
 * makes the number useless.
 */
export const ChildrenPanel = ({
  taskRef,
  projectKey,
  // Not named `children`: that is React's own prop, and passing an array of
  // tasks through it reads like a mistake even when it works.
  items,
}: {
  taskRef: string
  projectKey: string
  items: ChildTask[]
}) => {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closed = items.filter((c) => isTerminal(c.status)).length
  const pct = items.length ? Math.round((closed / items.length) * 100) : 0

  const create = async () => {
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/v1/projects/${projectKey}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: value, parentRef: taskRef, status: 'todo' }),
    })
    setBusy(false)
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      setError(json?.error ?? 'Could not create that sub-task.')
      return
    }
    setTitle('')
    router.refresh()
  }

  const detach = async (child: ChildTask) => {
    setBusy(true)
    await fetch(`/api/v1/tasks/${child.project_key}-${child.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRef: null }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-fg-subtle text-[11px] font-medium">
          Sub-tasks{items.length > 0 ? ` · ${closed}/${items.length}` : ''}
        </h2>
        {items.length > 0 && (
          <div
            className="bg-surface-raised h-[4px] w-[80px] overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${pct}% closed`}
          >
            <div className="bg-status-done h-full rounded-full" style={{ width: `${pct}%` }} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="text-fg-subtle hover:text-fg ml-auto text-[11px] transition-colors"
        >
          {adding ? 'Cancel' : 'Add sub-task'}
        </button>
      </div>

      {items.length > 0 && (
        <ul className="border-border divide-border divide-y rounded-md border">
          {items.map((c) => (
            <li key={c.id} className="group hover:bg-surface-hover flex h-[32px] items-center gap-2 px-2.5">
              <PriorityIcon priority={c.priority} />
              <StatusIcon status={c.status} size={13} />
              <Link
                href={`/projects/${c.project_key}/tasks/${c.number}`}
                prefetch
                className="text-fg min-w-0 flex-1 truncate text-[12.5px]"
              >
                {c.title}
              </Link>
              <code className="text-fg-subtle tabular shrink-0 text-[11px]">
                {c.project_key}-{c.number}
              </code>
              <button
                type="button"
                disabled={busy}
                onClick={() => void detach(c)}
                title="Lift it back to the top level"
                aria-label={`Detach ${c.project_key}-${c.number}`}
                className="text-fg-subtle hover:text-fg shrink-0 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
            if (e.key === 'Escape') setAdding(false)
          }}
          placeholder="What is the next piece?"
          aria-label="New sub-task title"
          className="border-border bg-bg text-fg placeholder:text-fg-subtle focus:border-accent mt-2 h-[30px] w-full rounded-md border px-2.5 text-[12.5px] outline-none"
        />
      )}

      {items.length === 0 && !adding && (
        <p className="text-fg-subtle text-[12px]">
          None. Split the work here when it is too big for one resolution.
        </p>
      )}

      {error && <p className="text-danger mt-1.5 text-[12px]">{error}</p>}
    </section>
  )
}
