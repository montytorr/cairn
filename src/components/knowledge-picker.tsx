'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/empty-state'

type Hit = { slug: string; title: string }

/**
 * Find one knowledge entry by typing, rather than scrolling every entry there is.
 *
 * This was a native `<select>` holding every current entry — 347 options of
 * roughly 77 characters each, shipped inside the HTML of every knowledge page
 * whether or not anyone intended to supersede anything, and growing with the
 * corpus forever.
 *
 * The size was the visible half. The real defect was the cap: the page loaded
 * candidates with `limit: 300` against 348 entries, so 48 of them could not be
 * chosen at all and nothing said so — the list looked complete because a list
 * always looks complete. `listKnowledge` carries a comment warning about
 * exactly this, that a filter over an already-limited page looks correct until
 * the corpus outgrows the limit. It had.
 *
 * Search asks the server, so there is no cap to outgrow and nothing is shipped
 * to a reader who never opens it.
 */
export const KnowledgePicker = ({
  exclude,
  onPick,
  placeholder = 'Search knowledge…',
}: {
  /** The entry doing the superseding cannot be the one superseded. */
  exclude?: string
  onPick: (hit: Hit) => void
  placeholder?: string
}) => {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = query.trim()
    // Cleared inside the timeout like every other transition, rather than
    // synchronously in the effect body: setting state during the effect pass
    // makes React re-render before it has finished the first one.
    if (term.length < 2) {
      const clear = setTimeout(() => setHits([]), 0)
      return () => clearTimeout(clear)
    }
    // Debounced, and every in-flight request is abandoned when the next
    // keystroke arrives — otherwise a slow early response can land after a
    // fast later one and repaint the list with results for a prefix the
    // person has already finished typing.
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const res = await fetch(
          `/api/v1/search?q=${encodeURIComponent(term)}&kinds=knowledge&limit=8`,
          { signal: controller.signal },
        )
        const json = await res.json()
        const rows: Hit[] = (json?.data?.results ?? [])
          .map((r: { ref: string; title: string }) => ({ slug: r.ref, title: r.title }))
          .filter((r: Hit) => r.slug !== exclude)
        setHits(rows)
      } catch {
        // An aborted or failed search leaves the previous list alone rather
        // than blanking it, which reads as "nothing matches".
      } finally {
        setBusy(false)
      }
    }, 180)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, exclude])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setTouched(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  return (
    <div ref={box} className="relative w-full max-w-[20rem]">
      <Search
        size={13}
        aria-hidden
        className="text-fg-subtle pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2"
      />
      <InlineInput
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setTouched(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setTouched(true)
        }}
        className="pr-10 pl-8"
      />
      {query && (
        <Button
          icon
          size="sm"
          variant="ghost"
          onClick={() => {
            setQuery('')
            setHits([])
          }}
          className="absolute top-0 right-0"
          aria-label="Clear"
        >
          <X size={14} aria-hidden />
        </Button>
      )}

      {touched && query.trim().length >= 2 && (
        <ul
          className={cn(
            'border-border bg-surface raised-lg enter-pop absolute z-30 mt-1 w-full rounded-lg border p-1',
            'max-h-[15rem] overflow-y-auto',
          )}
          style={{ '--origin': 'top left' } as React.CSSProperties}
        >
          {hits.length === 0 ? (
            <li>
              {busy ? (
                <p className="text-fg-subtle px-2.5 py-2 text-meta">Searching…</p>
              ) : (
                <EmptyState compact title="Nothing matches." />
              )}
            </li>
          ) : (
            hits.map((hit) => (
              <li key={hit.slug}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(hit)
                    setQuery('')
                    setHits([])
                    setTouched(false)
                  }}
                  className="hover:bg-accent-subtle focus-visible:bg-accent-subtle flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-[background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)] outline-none hover:shadow-[inset_2px_0_0_var(--accent)] focus-visible:shadow-[inset_2px_0_0_var(--accent)]"
                >
                  <span className="text-fg truncate text-ui">{hit.title}</span>
                  <span className="text-fg-subtle truncate font-mono text-meta">
                    {hit.slug}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
