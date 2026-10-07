'use client'

import { Plus, X } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate as write } from '@/lib/api/mutate'
import Link from 'next/link'
import { StatusIcon } from '@/components/icons'
import type { TaskStatus } from '@/schemas/task'
import type { Relation } from '@/lib/data'
import { cn } from '@/lib/utils'
import { ROW, ROW_LABEL } from './styles'

type Direction = 'blocked-by' | 'blocks'

type Hit = { ref: string; title: string; status: string }

const TITLE: Record<Direction, string> = {
  'blocked-by': 'Blocked by',
  blocks: 'Blocks',
}

const PLACEHOLDER: Record<Direction, string> = {
  'blocked-by': 'Search the task that blocks this…',
  blocks: 'Search the task this blocks…',
}

/**
 * The picker searches rather than listing every task: with hundreds of rows a
 * <select> is unusable, and search is already the fastest path to a ref.
 */
const Picker = ({
  direction,
  exclude,
  onPick,
  onClose,
}: {
  direction: Direction
  exclude: Set<string>
  onPick: (ref: string) => void
  onClose: () => void
}) => {
  const [query, setQuery] = useState('')
  // Hits are tagged with the query they answered, so a stale result set is
  // discarded by derivation rather than by clearing state from an effect.
  const [hits, setHits] = useState<{ q: string; rows: Hit[] }>({ q: '', rows: [] })
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return
    const controller = new AbortController()
    // Debounced so a fast typist fires one request, not one per keystroke.
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=8`, {
          signal: controller.signal,
        })
        const json = await res.json()
        setHits({ q, rows: res.ok ? (json.data?.results ?? []) : [] })
        setCursor(0)
      } catch {
        // An aborted request is the normal case here, not a failure.
      } finally {
        setLoading(false)
      }
    }, 180)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  // Filtered here rather than in the effect: `exclude` is rebuilt on every
  // parent render, and depending on it would refire the search each time.
  const q = query.trim()
  const visible =
    hits.q === q && q.length >= 2 ? hits.rows.filter((h) => !exclude.has(h.ref)) : []

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, visible.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // A typed ref is accepted directly, so a known id needs no search.
      const typed = q.toUpperCase()
      const pick = visible[cursor]?.ref ?? (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(typed) ? typed : null)
      if (pick) onPick(pick)
    }
  }

  return (
    <div
      className="pop flex flex-col gap-1"
      style={{ '--origin': 'top' } as React.CSSProperties}
    >
      <InlineInput
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Let a click on a suggestion land before the panel closes.
          setTimeout(onClose, 120)
        }}
        placeholder={PLACEHOLDER[direction]}
        aria-label={PLACEHOLDER[direction]}
      />
      {q.length >= 2 && (
        <div className="flex flex-col">
          {visible.map((h, i) => (
            <button
              key={h.ref}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(h.ref)}
              onMouseEnter={() => setCursor(i)}
              // The cursor row wears the trail marker, as a selected row does
              // anywhere else.
              className={cn(
                'flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-[background-color,box-shadow] duration-[var(--dur-1)]',
                i === cursor && 'bg-surface-hover shadow-[inset_2px_0_0_var(--accent)]',
              )}
            >
              <StatusIcon status={h.status as TaskStatus} size={12} />
              <span className="text-fg-muted min-w-0 truncate text-meta">{h.title}</span>
            </button>
          ))}
          {visible.length === 0 && (
            <span className="text-fg-subtle px-1.5 py-1 text-meta">
              {loading ? 'Searching…' : 'No match'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Both dependency directions, editable. Rendered even when empty so the
 * relationship is discoverable — it existed in the schema long before there
 * was any way to create one from here.
 */
export const DependencyEditor = ({
  taskRef,
  relations,
}: {
  taskRef: string
  relations: Relation[]
}) => {
  const router = useRouter()
  const [open, setOpen] = useState<Direction | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutate = useCallback(
    async (method: 'POST' | 'DELETE', direction: Direction, ref: string) => {
      setBusy(true)
      setError(null)
      try {
        // DELETE takes query params — the API does not read DELETE bodies.
        // `json.error.message` was always undefined, so the one refusal
        // with something precise to say — "that would be a loop" — showed a
        // generic sentence instead.
        const result = await write(
          method === 'DELETE'
            ? `/api/v1/tasks/${taskRef}/dependencies?${new URLSearchParams({ ref, direction })}`
            : `/api/v1/tasks/${taskRef}/dependencies`,
          method === 'DELETE' ? { method } : { method, body: { ref, direction } },
        )
        if (!result.ok) {
          setError(result.error)
          return
        }
        setOpen(null)
        router.refresh()
      } finally {
        setBusy(false)
      }
    },
    [taskRef, router],
  )

  return (
    <div className="flex flex-col">
      {(['blocked-by', 'blocks'] as const).map((direction) => {
        const items = relations.filter((r) => r.direction === direction)
        const refOf = (r: Relation) => `${r.project_key}-${r.number}`
        const exclude = new Set([taskRef, ...relations.map(refOf)])
        return (
          <div key={direction} className="group/dep flex flex-col">
            <div className={ROW}>
              <span className={ROW_LABEL}>{TITLE[direction]}</span>
              <span className="text-fg-subtle min-w-0 flex-1 truncate text-ui">
                {items.length === 0 && open !== direction ? 'None' : null}
              </span>
              <Button
                icon
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setOpen(open === direction ? null : direction)}
                aria-label={`Add a task that ${direction === 'blocked-by' ? 'blocks' : 'is blocked by'} this one`}
                className="md:opacity-0 md:group-hover/dep:opacity-100 focus-visible:opacity-100"
              >
                <Plus size={14} aria-hidden />
              </Button>
            </div>

            <div className="flex flex-col gap-0.5 pl-[calc(4.75rem+0.5rem)]">
              {items.map((r) => (
                <div
                  key={r.id}
                  className="row-hover group/row -mx-1.5 flex min-h-[var(--control-h-sm)] items-center gap-2 rounded-md px-1.5"
                >
                  <StatusIcon status={r.status as TaskStatus} size={13} />
                  <Link
                    href={`/projects/${r.project_key}/tasks/${r.number}`}
                    prefetch
                    className="text-fg-muted hover:text-fg min-w-0 flex-1 truncate text-ui"
                  >
                    {r.title}
                  </Link>
                  <Button
                    icon
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void mutate('DELETE', direction, refOf(r))}
                    aria-label={`Remove ${refOf(r)}`}
                    className="md:opacity-0 md:group-hover/row:opacity-100 focus-visible:opacity-100"
                  >
                    <X size={14} aria-hidden />
                  </Button>
                </div>
              ))}
            </div>

            {open === direction && (
              <Picker
                direction={direction}
                exclude={exclude}
                onPick={(ref) => void mutate('POST', direction, ref)}
                onClose={() => setOpen(null)}
              />
            )}
          </div>
        )
      })}
      {error && <span className="text-danger text-meta">{error}</span>}
    </div>
  )
}
