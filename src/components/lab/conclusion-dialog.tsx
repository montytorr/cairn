'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Textarea } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { StageBadge } from './stage'
import type { Stage } from './types'

/**
 * Entering a completed or dropped stage needs a conclusion: what was learned,
 * and what it means. A "rejected" with no reason is the least useful record a
 * lab can keep; the next person with the same idea deserves the why.
 *
 * Portalled to the body: it opens from a dragged card, a list row and the
 * subject's own rail, and any of those gaining a transform would make it the
 * box this fixed layer is fixed to. `onCancel` must be stable (the Escape
 * listener is bound to it).
 */
export const ConclusionDialog = ({
  subjectTitle,
  stage,
  initial = '',
  onCancel,
  onConfirm,
}: {
  subjectTitle: string
  stage: Pick<Stage, 'name' | 'color' | 'category'>
  initial?: string
  onCancel: () => void
  onConfirm: (conclusion: string) => Promise<boolean>
}) => {
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = async () => {
    if (!value.trim() || pending) return
    setPending(true)
    const ok = await onConfirm(value.trim())
    if (!ok) setPending(false)
  }

  const dropped = stage.category === 'dropped'

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conclusion-title"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-fg-subtle flex items-center gap-1.5 text-meta">
          Moving to <StageBadge stage={stage} className="text-fg-muted font-medium" />
        </p>
        <h2 id="conclusion-title" className="text-fg mt-1.5 text-ui font-semibold">
          {dropped ? 'Why is' : 'What did'} “{subjectTitle}” {dropped ? 'being dropped?' : 'conclude?'}
        </h2>
        <p className="text-fg-muted mt-1 text-meta leading-relaxed">
          {dropped
            ? 'Say why, so the next person with the same idea starts from here rather than from scratch.'
            : 'What was learned, and what it means. It is the first thing anyone reads on this subject.'}
        </p>

        <Textarea
          ref={ref}
          rows={5}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder={
            dropped
              ? 'Licence cost scales per seat; at our size it is three times the budget.'
              : 'Works for batch jobs under 10 GB; beyond that the cold start dominates.'
          }
          className="mt-3"
        />

        <div className="mt-3 flex items-center gap-2">
          <span className="text-fg-subtle hidden text-meta sm:block">⌘↵ to save</span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={!value.trim() || pending}>
              {pending ? <Spinner /> : 'Conclude and move'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
