'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Field, Input, Select } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { mutate } from '@/lib/api/mutate'
import { isConcluding, subjectHref, type Stage, type Subject } from './types'

/**
 * Filing a subject: a title, and the stage it starts at. A stage that ends a
 * subject (completed, dropped) is left out: it would need a conclusion, and a
 * new subject has none to give. Everything else is the subject's own page.
 */
export const CreateSubjectDialog = ({
  stages,
  onClose,
}: {
  stages: Stage[]
  /** Must be stable: the Escape listener is bound to it. */
  onClose: () => void
}) => {
  const router = useRouter()
  const open = stages.filter((s) => !isConcluding(s.category))
  const [title, setTitle] = useState('')
  const [stage, setStage] = useState(open[0]?.id ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!title.trim() || pending) return
    setPending(true)
    setError(null)
    const result = await mutate<Subject>('/api/v1/subjects', {
      method: 'POST',
      body: { title: title.trim(), ...(stage ? { stage } : {}) },
    })
    if (!result.ok) {
      setPending(false)
      setError(result.error)
      return
    }
    router.push(subjectHref(result.data.number))
    router.refresh()
  }

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-subject-title"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 id="create-subject-title" className="text-ui font-semibold">
          New subject
        </h2>
        <p className="text-fg-muted mt-1 text-meta leading-relaxed">
          A technology to evaluate, a proof of concept, an idea. Write it up on its own page.
        </p>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Title">
            <Input
              ref={input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder="Evaluate pgvector for recall"
            />
          </Field>
          {open.length > 1 ? (
            <Field label="Starts at">
              <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                {open.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-danger mt-3 text-meta">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || pending}>
            {pending ? <Spinner /> : 'Create subject'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
