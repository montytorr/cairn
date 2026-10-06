'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, InlineInput } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { keyChangeProblem } from '@/lib/project-rename'
import { cn } from '@/lib/utils'

export type KeyedProject = { id: string; key: string; title: string }
export type RetiredKeyOwner = { key: string; project_id: string; current: string }

/**
 * Changes the prefix of every ref a project has issued.
 *
 * The API could always do this and nothing else could, so the one edit most in
 * need of explaining was the one nobody saw explained. The dialog says the two
 * things a reader cannot guess: that old refs keep resolving, and that the old
 * key is spent for good — no other project may ever take it, or its refs would
 * lead to two tasks. The same rules are checked while typing so a refusal is
 * not the first time anyone hears them; the server still has the last word.
 */
export const ChangeKeyDialog = ({
  project,
  liveKeys,
  retired,
  onClose,
  onChanged,
}: {
  project: KeyedProject
  liveKeys: string[]
  retired: RetiredKeyOwner[]
  onClose: () => void
  onChanged: (key: string) => void
}) => {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const next = draft.trim().toUpperCase()
  const problem = keyChangeProblem(next, {
    projectId: project.id,
    current: project.key,
    liveKeys: liveKeys.filter((key) => key !== project.key),
    retired,
  })
  const reclaiming = !problem && retired.some((row) => row.key === next && row.project_id === project.id)

  const submit = async () => {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    const result = await mutate(`/api/v1/projects/${project.id}`, {
      method: 'PATCH',
      body: { key: next },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChanged(next)
  }

  // Portalled to <body>, like the resolution dialog: a `fixed` layer inside
  // any transformed or filtered ancestor is positioned by that ancestor.
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div className="scrim absolute inset-0" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-key-title"
        className="border-border bg-surface raised-lg enter-sheet relative flex w-full max-w-[28rem] flex-col overflow-hidden rounded-xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="change-key-title"
          className="border-border text-fg border-b px-4 py-3 text-ui font-medium sm:px-5"
        >
          Change the key of {project.title}
        </h2>
        <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
          <p className="text-fg-muted text-ui leading-relaxed">
            Every task here is referred to as{' '}
            <span className="text-fg font-mono">{next && !problem ? next : 'NEW'}-n</span> from now
            on. Old refs keep working: <span className="font-mono">{project.key}-42</span> in a
            commit message, a PR title or an agent&apos;s note still leads to its task, and the task
            says what it used to be called.
          </p>
          <p className="text-fg-subtle text-meta leading-relaxed">
            {project.key} stays reserved for this project. No other project can ever take it, because
            its old refs would then lead to two tasks.
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-fg-subtle text-meta font-medium">New key</span>
            <InlineInput
              autoFocus
              value={draft}
              placeholder={project.key}
              maxLength={10}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value.toUpperCase())
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') onClose()
              }}
              aria-invalid={Boolean(draft && problem)}
              aria-describedby="change-key-hint"
              className="w-[8rem] font-mono uppercase"
            />
          </label>
          <p
            id="change-key-hint"
            className={cn(
              'text-meta',
              error || (draft && problem) ? 'text-danger' : 'text-fg-subtle',
            )}
          >
            {error ??
              (draft && problem
                ? problem
                : reclaiming
                  ? `${next} was this project's key before — taking it back makes it live again.`
                  : 'Two to ten letters or digits, starting with a letter.')}
          </p>
        </div>

        <div className="border-border bg-surface-raised/40 flex justify-end gap-2 border-t px-4 py-3 sm:px-5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={Boolean(problem) || busy} onClick={() => void submit()}>
            {busy ? 'Changing…' : next && !problem ? `Change to ${next}` : 'Change key'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
