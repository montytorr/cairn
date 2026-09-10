'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { NOTE_KINDS, type NoteKind } from '@/schemas/task'
import type { Note } from '@/lib/data'

const KIND_STYLE: Record<string, string> = {
  finding: 'text-status-todo',
  decision: 'text-status-in-review',
  attempt: 'text-status-doing',
  handoff: 'text-priority-high',
  note: 'text-fg-subtle',
}

/**
 * The work log, rendered dense and collapsed by default. This is the debugging
 * trail — attempts and dead ends included, because "tried X, no difference" is
 * what stops the next agent repeating it.
 */
export const NotesPanel = ({ taskId, notes }: { taskId: string; notes: Note[] }) => {
  const router = useRouter()
  const [text, setText] = useState('')
  const [kind, setKind] = useState<NoteKind>('note')
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const res = await fetch(`/api/v1/tasks/${taskId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: text.trim(), kind }),
    })
    setPending(false)
    if (res.ok) {
      setText('')
      router.refresh()
    }
  }

  return (
    <section>
      <h2 className="text-fg-muted mb-2 flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
        Work log
        <span className="tabular text-fg-subtle">{notes.length}</span>
      </h2>

      <div className="mb-3 flex gap-2">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="What did you try, find, or decide?"
          className="border-border bg-bg focus:border-accent min-w-0 flex-1 resize-none rounded-md border px-2.5 py-2 text-[13px] outline-none transition-colors"
        />
        <div className="flex flex-col gap-1.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as NoteKind)}
            className="border-border bg-bg rounded-md border px-1.5 py-1 text-[11px]"
            aria-label="Note kind"
          >
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || pending}
            className="bg-accent text-accent-fg rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-50"
          >
            {pending ? '…' : 'Add'}
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <p className="text-fg-subtle text-xs">
          Nothing logged yet. Dead ends are worth recording too.
        </p>
      ) : (
        <ul className="divide-border border-border divide-y overflow-hidden rounded-md border">
          {notes.map((note) => {
            const isOpen = expanded === note.id
            const long = note.note.length > 140
            return (
              <li key={note.id} className="px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className={cn('font-medium', KIND_STYLE[note.kind] ?? 'text-fg-subtle')}>
                    {note.kind}
                  </span>
                  <span className={note.actor_type === 'agent' ? 'text-accent' : 'text-fg-subtle'}>
                    {note.actor_type === 'agent' ? note.actor_id : 'you'}
                  </span>
                  <span className="text-fg-subtle tabular ml-auto">
                    {note.created_at.slice(0, 16).replace('T', ' ')}
                  </span>
                </div>

                <div className={cn(!isOpen && long && 'line-clamp-2')}>
                  <MarkdownView>{note.note}</MarkdownView>
                </div>

                {long && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : note.id)}
                    className="text-fg-subtle hover:text-fg mt-1 text-[11px]"
                  >
                    {isOpen ? 'less' : 'more'}
                  </button>
                )}

                {note.facts && note.facts.length > 0 && (
                  <ul className="text-fg-muted mt-1.5 ml-3 list-disc text-[12px]">
                    {note.facts.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
