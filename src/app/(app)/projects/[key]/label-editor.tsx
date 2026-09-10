'use client'

import { InlineInput } from '@/components/ui/control'

import { useEffect, useRef, useState } from 'react'
import { LabelPill } from '@/components/icons'

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
}: {
  taskRef: string
  labels: string[]
  known: string[]
  onChange: (next: string[]) => void
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
    <span ref={wrap} className="pointer-events-auto relative z-10 inline-flex items-center gap-1.5">
      {labels.slice(0, 2).map((l) => (
        <LabelPill key={l}>{l}</LabelPill>
      ))}
      {labels.length > 2 && (
        <span className="text-fg-subtle text-[11px]">+{labels.length - 2}</span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-label={`Labels on ${taskRef}`}
        aria-expanded={open}
        className={`text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-[18px] place-items-center rounded transition ${
          labels.length === 0 && !open ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 11 11" aria-hidden>
          <path
            d="M5.5 1.5v8M1.5 5.5h8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="border-border bg-surface absolute top-[24px] right-0 z-50 w-[190px] overflow-hidden rounded-md border py-1 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-[190px] overflow-y-auto">
            {options.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => toggle(l)}
                className="hover:bg-surface-hover flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
              >
                <input
                  type="checkbox"
                  readOnly
                  tabIndex={-1}
                  checked={labels.includes(l)}
                  className="accent-accent size-[12px]"
                />
                <span className="text-fg-muted min-w-0 truncate text-[12px]">{l}</span>
              </button>
            ))}
            {options.length === 0 && (
              <p className="text-fg-subtle px-2.5 py-1.5 text-[11px]">No labels yet.</p>
            )}
          </div>

          <div className="border-border mt-1 border-t px-1.5 pt-1.5">
            <InlineInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
              placeholder="New label…"
              aria-label="New label"
              className="h-[26px] text-[12px]"
            />
          </div>
        </div>
      )}
    </span>
  )
}
