'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { MarkdownView } from '@/components/markdown'
import { usePeople } from '@/components/people-context'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { Button, Textarea } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import type { HumanNote } from './types'

/** One card, read or being edited by its author. */
const NoteCard = ({
  subjectRef,
  note,
  canEdit,
  canDelete,
}: {
  subjectRef: string
  note: HumanNote
  canEdit: boolean
  canDelete: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.body)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)

  const base = `/api/v1/subjects/${subjectRef}/human-notes/${note.id}`

  const save = async () => {
    if (!text.trim() || busy) return
    if (text.trim() === note.body) {
      setEditing(false)
      return
    }
    setBusy(true)
    const result = await request(base, { method: 'PATCH', body: { body: text.trim() } })
    setBusy(false)
    if (!result.ok) return
    setEditing(false)
    router.refresh()
  }

  const remove = async () => {
    setBusy(true)
    const result = await request(base, { method: 'DELETE' })
    setBusy(false)
    if (result.ok) router.refresh()
  }

  const author = note.author?.name ?? note.actor_id

  return (
    <li className="surface-card group px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-meta">
        <Avatar name={author} size={16} />
        <span className="text-fg-muted">{author}</span>
        <span className="text-fg-subtle tabular ml-auto flex items-center gap-1.5">
          <RelativeTime iso={note.created_at} />
          {note.updated_at !== note.created_at ? <span>· edited</span> : null}
        </span>
        {!editing && (canEdit || canDelete) ? (
          <span className="flex items-center gap-0.5 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
            {canEdit ? (
              <Button
                icon
                size="sm"
                variant="ghost"
                aria-label="Edit this note"
                onClick={() => {
                  setText(note.body)
                  setEditing(true)
                }}
              >
                <Pencil size={13} aria-hidden />
              </Button>
            ) : null}
            {canDelete ? (
              asking ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void remove()}
                  onBlur={() => setAsking(false)}
                  autoFocus
                >
                  Delete?
                </Button>
              ) : (
                <Button icon size="sm" variant="ghost" aria-label="Delete this note" onClick={() => setAsking(true)}>
                  <Trash2 size={13} aria-hidden />
                </Button>
              )
            ) : null}
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
            aria-label="Edit note"
            className="max-h-[40vh] w-full"
            rows={3}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => void save()}>
              {busy ? <Spinner /> : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownView>{note.body}</MarkdownView>
      )}
    </li>
  )
}

/**
 * People's notes: cards anyone can add, in markdown. Only the author edits
 * one, and the author or an administrator deletes it. An agent's key writes
 * as its human, so the person and their agents are one author.
 */
export const HumanNotesPanel = ({
  subjectRef,
  notes,
  isAdmin,
}: {
  subjectRef: string
  notes: HumanNote[]
  isAdmin: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const { currentUserId } = usePeople()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const result = await request(`/api/v1/subjects/${subjectRef}/human-notes`, {
      method: 'POST',
      body: { body: text.trim() },
    })
    setPending(false)
    // What was typed stays in the box when it is refused.
    if (!result.ok) return
    setText('')
    router.refresh()
  }

  return (
    <section aria-label="People's notes" className="max-w-[51.25rem]">
      <div className="mb-4 flex flex-col gap-2">
        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder="Add a note for whoever picks this up…"
          aria-label="Add a note"
          className="max-h-[40vh] w-full"
        />
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle ml-auto hidden text-meta sm:block">
            <kbd className="kbd inline-flex">⌘</kbd>
            <kbd className="kbd ml-0.5 inline-flex">↵</kbd>
          </span>
          <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!text.trim() || pending}>
            {pending ? <Spinner /> : 'Add note'}
          </Button>
        </div>
      </div>

      {notes.length === 0 ? (
        <EmptyState compact title="No notes yet." hint="Notes are for people; the log is for agents and the record." />
      ) : (
        <ul className="stagger flex flex-col gap-2">
          {notes.map((note) => {
            const mine = Boolean(note.author && note.author.id === currentUserId)
            return (
              <NoteCard
                key={note.id}
                subjectRef={subjectRef}
                note={note}
                canEdit={mine}
                canDelete={mine || isAdmin}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
