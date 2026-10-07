'use client'

import { InlineInput } from '@/components/ui/control'

import { useEffect, useRef, useState } from 'react'
import { LabelPill } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'

/**
 * Labels are a set, so a `<select>` cannot express them — this is the one
 * quick-edit control that needs a popover.
 *
 * It offers the labels already in use before it offers a text field, which is
 * the whole reason `db`, `database` and `postgres` stop multiplying.
 */
export const LabelEditor = ({
  taskRef,
  labels,
  known,
  onChange,
  alwaysVisible = false,
}: {
  taskRef: string
  labels: string[]
  known: string[]
  onChange: (next: string[]) => void
  /**
   * A list row reveals the add control on hover, since a page of rows
   * showing "+" on every empty one is louder than the list itself. A
   * sidebar has exactly one Labels row and no hover cue to teach, so it
   * keeps a standing "Add label" affordance instead of a blank gap.
   */
  alwaysVisible?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const wrap = useRef<HTMLSpanElement>(null)

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

  const toggle = (label: string) =>
    onChange(labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label])

  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (!labels.includes(value)) onChange([...labels, value])
    setDraft('')
    setOpen(false)
  }

  const options = [...new Set([...labels, ...known])]

  return (
    // Raised while open: at z-10 the menu shared a level with the badges on
    // the rows below it, and they came later in the page, so they won.
    <span
      ref={wrap}
      className={`pointer-events-auto relative inline-flex items-center gap-1.5 ${open ? 'z-30' : 'z-10'}`}
    >
      {labels.slice(0, 2).map((l) => (
        <LabelPill key={l}>{l}</LabelPill>
      ))}
      {labels.length > 2 && (
        <span className="text-fg-subtle text-meta">+{labels.length - 2}</span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-label={`Labels on ${taskRef}`}
        aria-expanded={open}
        className={cn(
          'text-fg-subtle hover:text-fg rounded transition-[opacity,color,background-color] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          'hover:bg-[color-mix(in_oklab,var(--fg)_7%,transparent)]',
          labels.length === 0 && alwaysVisible
            ? 'inline-flex h-6 items-center gap-1 px-1.5 text-meta'
            : 'grid size-6 place-items-center',
          !alwaysVisible && labels.length === 0 && !open
            ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            : 'opacity-100',
        )}
      >
        <svg width="10" height="10" viewBox="0 0 11 11" aria-hidden className="shrink-0">
          <path
            d="M5.5 1.5v8M1.5 5.5h8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        {labels.length === 0 && alwaysVisible ? 'Add label' : null}
      </button>

      {open && (
        <div
          // In the sidebar the trigger sits at the start of a narrow column that
          // clips sideways, so the menu opens rightwards into it, not out of it.
          role="menu"
          className={cn(
            'border-border bg-surface pop absolute top-full z-50 mt-1 overflow-hidden rounded-lg border py-1 raised',
            alwaysVisible ? 'left-0 w-[10.5rem]' : 'right-0 w-[11.875rem]',
          )}
          style={{ '--origin': alwaysVisible ? 'top left' : 'top right' } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-[11.875rem] overflow-y-auto">
            {options.map((l) => (
              <button
                key={l}
                type="button"
                role="menuitemcheckbox"
                aria-checked={labels.includes(l)}
                onClick={() => toggle(l)}
                className="hover:bg-surface-hover flex min-h-8 w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-1)]"
              >
                <input
                  type="checkbox"
                  readOnly
                  tabIndex={-1}
                  checked={labels.includes(l)}
                  className="pointer-events-none"
                />
                <span className="text-fg-muted min-w-0 truncate text-meta">{l}</span>
              </button>
            ))}
            {options.length === 0 && <EmptyState compact title="No labels yet." className="py-3" />}
          </div>

          <div className="border-border mt-1 border-t p-1.5">
            <InlineInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
              placeholder="New label…"
              aria-label="New label"
            />
          </div>
        </div>
      )}
    </span>
  )
}
