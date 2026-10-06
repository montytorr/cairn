'use client'

import { InlineInput } from '@/components/ui/control'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api/mutate'
import { LabelPill } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { SettingsCard } from './settings-card'

export type LabelRow = { label: string; task_count: number }

/**
 * Rename, merge and delete are the same control: typing an existing label as
 * the new name merges the two, which is how the drift actually gets cleaned
 * up. Said out loud in the hint rather than left to be discovered.
 */
export const LabelsSection = ({ labels }: { labels: LabelRow[] }) => {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const existing = new Set(labels.map((l) => l.label))

  const apply = async (from: string, to: string | null) => {
    setBusy(true)
    setMessage(null)
    const result = await mutate<{ tasksChanged: number }>('/api/v1/labels', {
      method: 'PATCH',
      body: { from, to },
    })
    setBusy(false)
    if (!result.ok) {
      setMessage(result.error)
      return
    }
    setEditing(null)
    setMessage(
      to === null
        ? `Removed “${from}” from ${result.data.tasksChanged} task(s).`
        : `${result.data.tasksChanged} task(s) now carry “${to}”.`,
    )
    router.refresh()
  }

  return (
    <SettingsCard
      title="Labels"
      flush
      description={
        <>Renaming a label to one that exists merges the two.</>
      }
      footer={message ? <p className="text-fg-muted enter-rise text-meta">{message}</p> : undefined}
    >
      {labels.length === 0 ? (
        <EmptyState compact title="No labels in use." />
      ) : (
        <ul className="divide-border stagger divide-y">
          {labels.map((l) => (
            <li
              key={l.label}
              className="row-hover group flex min-h-[2.375rem] items-center gap-2 px-4 py-1.5 md:px-5"
            >
              {editing === l.label ? (
                <>
                  <InlineInput
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.trim()) void apply(l.label, draft.trim())
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label={`Rename ${l.label}`}
                    className="min-w-0 flex-1"
                  />
                  {existing.has(draft.trim()) && draft.trim() !== l.label && (
                    <span className="text-fg-subtle shrink-0 text-meta">merges</span>
                  )}
                  <button
                    type="button"
                    disabled={busy || !draft.trim()}
                    onClick={() => void apply(l.label, draft.trim())}
                    className="text-accent shrink-0 text-meta disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-fg-subtle hover:text-fg shrink-0 text-meta transition-colors duration-[var(--dur-1)]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <LabelPill>{l.label}</LabelPill>
                  <span className="text-fg-subtle tabular ml-auto shrink-0 text-meta">
                    {l.task_count} task{l.task_count === 1 ? '' : 's'}
                  </span>
                  {/* Quiet until the row is under the pointer; always there on
                      touch, where there is no hover to reveal them. */}
                  <span className="flex shrink-0 items-center gap-2 transition-opacity duration-[var(--dur-1)] ease-[var(--ease-out)] md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(l.label)
                        setDraft(l.label)
                      }}
                      className="text-fg-muted hover:text-fg text-meta transition-colors duration-[var(--dur-1)]"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void apply(l.label, null)}
                      className="text-fg-subtle hover:text-danger text-meta transition-colors duration-[var(--dur-1)]"
                    >
                      Remove
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
