'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { mutate } from '@/lib/api/mutate'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Archiving is the normal way to retire a subject. Deleting is for mistakes
 * and duplicates, and it never destroys task history: a subject with todos is
 * refused unless the todos are detached, and a detached todo keeps its
 * project, number, notes, files and events.
 *
 * The destructive button stays off until the ref is typed, and the safe choice
 * (Cancel) has focus. The todo count is the page's; if the server says there
 * are more (409 `subject_has_todos`), the dialog switches to the detach
 * wording and asks again rather than guessing.
 *
 * `onClose` must be stable (the Escape listener is bound to it).
 */
export const DeleteSubjectDialog = ({
  subjectRef,
  subjectTitle,
  todos,
  onClose,
  onDeleted,
}: {
  subjectRef: string
  subjectTitle: string
  todos: number
  onClose: () => void
  onDeleted: () => void
}) => {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [todoCount, setTodoCount] = useState(todos)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancel.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const matches = typed.trim().toUpperCase() === subjectRef.toUpperCase()

  const confirm = async () => {
    if (pending || !matches) return
    setPending(true)
    setError(null)
    const query = new URLSearchParams({ confirm: subjectRef })
    if (todoCount > 0) query.set('todos', 'detach')
    const result = await mutate(`/api/v1/subjects/${subjectRef}?${query}`, { method: 'DELETE' })
    if (result.ok) {
      onDeleted()
      return
    }
    setPending(false)
    if (result.code === 'subject_has_todos') {
      // Someone added a todo since the page rendered. Say so; the next press detaches.
      setTodoCount((n) => Math.max(n, 1))
      setError('This subject has todos now. Delete again to detach them and remove it.')
      return
    }
    setError(result.error)
  }

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-subject-title"
        aria-describedby="delete-subject-body"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <h2 id="delete-subject-title" className="text-ui font-semibold">
          Delete {subjectRef}: “{subjectTitle}”?
        </h2>
        <div id="delete-subject-body" className="text-fg-muted mt-2 flex flex-col gap-2 text-ui leading-relaxed">
          <p>
            This removes the subject, its log, people&apos;s notes and files. Archiving keeps all of
            that and leaves the subject searchable.
          </p>
          {todoCount > 0 ? (
            <p>
              Its {plural(todoCount, 'todo')} {todoCount === 1 ? 'is' : 'are'} detached, not deleted:
              each keeps its project, number, status, notes and history, and a note says it was
              a todo of {subjectRef}.
            </p>
          ) : null}
          <p className="text-fg font-medium">This cannot be undone.</p>
        </div>

        <label className="text-fg-muted mt-3 flex flex-col gap-1.5 text-meta">
          <span>
            Type <span className="text-fg font-mono">{subjectRef}</span> to confirm
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={subjectRef}
          />
        </label>

        {error ? (
          <p role="alert" className="text-danger mt-3 text-meta">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancel} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!matches || pending}>
            {pending ? <Spinner /> : todoCount > 0 ? 'Detach todos and delete' : 'Delete subject'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
