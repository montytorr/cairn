'use client'

import { useEffect, useRef, useState } from 'react'
import { RESOLUTION_KINDS, type ResolutionKind, type TaskStatus } from '@/schemas/task'

/**
 * Closing a task requires saying how it ended, so this is the friction point
 * where that rule meets the human.
 *
 * It is kept deliberately light — one textarea, prefilled from the last
 * checkpoint where there is one, so the common case is "confirm" rather than
 * "compose". Friction on the close path is where trackers rot, and the whole
 * value of a recorded resolution is lost if people route around it.
 */
export const ResolutionDialog = ({
  taskTitle,
  status,
  suggestion,
  onCancel,
  onConfirm,
}: {
  taskTitle: string
  status: TaskStatus
  suggestion: string | null
  onCancel: () => void
  onConfirm: (resolution: string, kind: ResolutionKind) => Promise<boolean>
}) => {
  const [value, setValue] = useState(suggestion ?? '')
  const [kind, setKind] = useState<ResolutionKind>(status === 'cancelled' ? 'wont-fix' : 'fixed')
  const [pending, setPending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = async () => {
    if (!value.trim() || pending) return
    setPending(true)
    const ok = await onConfirm(value.trim(), kind)
    if (!ok) setPending(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-surface border-border w-full max-w-md rounded-lg border p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">
          {status === 'cancelled' ? 'Cancel' : 'Close'} “{taskTitle}”
        </h2>
        <p className="text-fg-muted mt-1 text-xs leading-relaxed">
          Record what was actually done, and why. This is what a future agent finds when it
          asks whether this was already solved.
        </p>

        <textarea
          ref={ref}
          rows={4}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="raised supavisor pool_size to 40; the default 15 was the cap"
          className="border-border bg-bg focus:border-accent mt-3 w-full resize-none rounded-md border px-2.5 py-2 text-sm outline-none transition-colors"
        />

        {suggestion && value === suggestion && (
          <p className="text-fg-subtle mt-1.5 text-[11px]">
            Prefilled from the last checkpoint — edit it if that is not the whole story.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ResolutionKind)}
            className="border-border bg-bg rounded-md border px-2 py-1.5 text-xs"
            aria-label="Resolution kind"
          >
            {RESOLUTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="text-fg-muted hover:bg-surface-raised rounded-md px-3 py-1.5 text-xs transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || pending}
              className="bg-accent text-accent-fg rounded-md px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50"
            >
              {pending ? 'Saving…' : status === 'cancelled' ? 'Cancel task' : 'Close task'}
            </button>
          </div>
        </div>
        <p className="text-fg-subtle mt-2 text-[11px]">⌘↵ to save</p>
      </div>
    </div>
  )
}
