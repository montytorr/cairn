'use client'

import { useEffect, useRef, useState } from 'react'
import { RESOLUTION_KINDS, type ResolutionKind, type TaskStatus } from '@/schemas/task'
import { Button, Select, Textarea, InlineInput } from '@/components/ui/control'

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
  allowDuplicate = true,
  onCancel,
  onConfirm,
}: {
  taskTitle: string
  status: TaskStatus
  suggestion: string | null
  /**
   * Withheld when closing many tasks at once: forty tasks are not all
   * duplicates of the same one thing, and offering the kind without being
   * able to honour the pointer would silently discard what was typed.
   */
  allowDuplicate?: boolean
  onCancel: () => void
  onConfirm: (
    resolution: string,
    kind: ResolutionKind,
    duplicateOf?: string,
  ) => Promise<boolean>
}) => {
  const [value, setValue] = useState(suggestion ?? '')
  const [kind, setKind] = useState<ResolutionKind>(status === 'cancelled' ? 'wont-fix' : 'fixed')
  const [pending, setPending] = useState(false)
  const [duplicateOf, setDuplicateOf] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // "duplicate" without naming the original sends the reader off to search for
  // it, which is the work the resolution was supposed to save.
  const needsOriginal = kind === 'duplicate'
  const originalOk = !needsOriginal || /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(duplicateOf.trim())

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = async () => {
    if (!value.trim() || pending || !originalOk) return
    setPending(true)
    const ok = await onConfirm(
      value.trim(),
      kind,
      needsOriginal ? duplicateOf.trim().toUpperCase() : undefined,
    )
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

        <Textarea
          ref={ref}
          rows={4}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="raised supavisor pool_size to 40; the default 15 was the cap"
          className="mt-3"
        />

        {suggestion && value === suggestion && (
          <p className="text-fg-subtle mt-1.5 text-[11px]">
            Prefilled from the last checkpoint — edit it if that is not the whole story.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Select
            size="sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as ResolutionKind)}
            className="w-40"
            aria-label="Resolution kind"
          >
            {RESOLUTION_KINDS.filter((k) => allowDuplicate || k !== 'duplicate').map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>

          {needsOriginal && (
            <InlineInput
              value={duplicateOf}
              onChange={(e) => setDuplicateOf(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
              placeholder="duplicate of… CAI-31"
              aria-label="The task this duplicates"
              className="w-[150px]"
            />
          )}

          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} className="w-auto px-3">
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={submit}
              disabled={!value.trim() || pending || !originalOk}
              className="w-auto px-3"
            >
              {pending ? 'Saving…' : status === 'cancelled' ? 'Cancel task' : 'Close task'}
            </Button>
          </div>
        </div>
        <p className="text-fg-subtle mt-2 text-[11px]">⌘↵ to save</p>
      </div>
    </div>
  )
}
