'use client'

import { useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/control'
import { cn } from '@/lib/utils'

/**
 * A multi-select popover. The same outside-click/Escape pattern as
 * `label-editor.tsx` and `bulk-bar.tsx`'s `Action` menu — one look for every
 * menu in the app.
 */
export const FilterMenu = ({
  label,
  options,
  selected,
  onChange,
  summary,
  reset,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
  /** The button's text in place of `label` and a count, e.g. "Assignee: Me". */
  summary?: string
  /** A first row that empties the selection, for a filter whose empty is a choice ("Everyone"). */
  reset?: string
}) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  return (
    <div ref={wrap} className="relative">
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Filter by ${label}`}
        className={cn(selected.length > 0 && 'border-accent/70 text-accent bg-accent-subtle hover:bg-accent-subtle')}
      >
        {summary ?? label}
        {!summary && selected.length > 0 && <span className="tabular">{selected.length}</span>}
      </Button>

      {open && (
        <div
          role="menu"
          className="border-border bg-surface pop absolute top-[2.25rem] left-0 z-50 max-h-[15rem] w-[12.5rem] overflow-y-auto rounded-lg border py-1 raised"
          style={{ '--origin': 'top left' } as React.CSSProperties}
        >
          {reset && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected.length === 0}
              onClick={() => onChange([])}
              className="hover:bg-surface-hover border-border mb-1 flex min-h-8 w-full items-center gap-2 border-b px-2.5 pt-1 pb-1.5 text-left transition-colors duration-[var(--dur-1)]"
            >
              <input
                type="checkbox"
                readOnly
                tabIndex={-1}
                checked={selected.length === 0}
                className="pointer-events-none"
              />
              <span className="text-fg-muted min-w-0 truncate text-meta">{reset}</span>
            </button>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected.includes(o.value)}
              onClick={() => toggle(o.value)}
              className="hover:bg-surface-hover flex min-h-8 w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-1)]"
            >
              <input
                type="checkbox"
                readOnly
                tabIndex={-1}
                checked={selected.includes(o.value)}
                className="pointer-events-none"
              />
              <span className="text-fg-muted min-w-0 truncate text-meta">{o.label}</span>
            </button>
          ))}
          {options.length === 0 && <EmptyState compact title="Nothing to filter by yet." />}
        </div>
      )}
    </div>
  )
}
