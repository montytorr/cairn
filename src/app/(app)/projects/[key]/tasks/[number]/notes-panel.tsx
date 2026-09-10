'use client'

import { RelativeTime } from '@/components/relative-time'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { NOTE_KINDS, type NoteKind } from '@/schemas/task'
import { Button, Select, Textarea } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import type { Note } from '@/lib/data'

const KIND_STYLE: Record<string, string> = {
  finding: 'text-status-todo',
  decision: 'text-status-in-review',
  attempt: 'text-status-doing',
  handoff: 'text-priority-high',
  note: 'text-fg-subtle',
}

/**
 * The rail marker. Filled for the latest entry, hollow for the rest — so the
 * eye lands on where the work got to without reading a single date.
 */
const RailMarker = ({
  ordinal,
  latest,
  kind,
}: {
  ordinal: number
  latest: boolean
  kind: string
}) => (
  <span
    className={cn(
      'tabular relative z-10 grid size-[22px] shrink-0 place-items-center rounded-full border text-[10px] font-medium',
      latest
        ? 'border-accent bg-accent-subtle text-accent'
        : 'border-border bg-bg text-fg-subtle',
    )}
    title={kind}
  >
    {latest ? <span className="bg-accent size-[7px] rounded-full" /> : ordinal}
  </span>
)

/**
 * The work log, rendered dense and collapsed by default. This is the debugging
 * trail — attempts and dead ends included, because "tried X, no difference" is
 * what stops the next agent repeating it.
 */
export const NotesPanel = ({ taskId, notes: initial }: { taskId: string; notes: Note[] }) => {
  const router = useRouter()
  // Appended locally on submit rather than re-rendering the whole page.
  // router.refresh() re-runs every server component on the route, which is
  // needless work for "add one row to a list" and very noticeable when the
  // host is under load.
  const [notes, setNotes] = useState(initial)
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
    if (!res.ok) return

    const payload = await res.json().catch(() => null)
    const created = payload?.data
    setText('')

    if (created?.duplicate) return // identical note already recorded
    if (created?.id) {
      setNotes((current) => [created as Note, ...current])
    } else {
      router.refresh() // unexpected shape; fall back to a reload
    }
  }

  return (
    <section>
      <h2 className="text-fg-muted mb-2.5 flex items-center gap-2 text-[11px] font-medium">
        Work log
        <span className="tabular text-fg-subtle">{notes.length}</span>
      </h2>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="What did you try, find, or decide? Dead ends count."
          className="min-w-0 flex-1"
        />
        <div className="flex shrink-0 gap-1.5 sm:w-28 sm:flex-col">
          <Select
            size="sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as NoteKind)}
            aria-label="Note kind"
            className="flex-1 sm:flex-none"
          >
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            disabled={!text.trim() || pending}
            className="flex-1 sm:flex-none"
          >
            {pending ? <Spinner /> : 'Add note'}
          </Button>
        </div>
      </div>

      {notes.length === 0 ? (
        <p className="text-fg-subtle border-border rounded-md border border-dashed px-3 py-4 text-center text-[12px]">
          Nothing logged yet. Dead ends are worth recording too.
        </p>
      ) : (
        <ol className="relative flex flex-col">
          {/* One continuous line behind the markers, rather than a border per
              row — a divided list of boxes reads as a table, and this is a
              sequence. */}
          <span
            className="bg-border absolute top-[11px] bottom-[11px] left-[10.5px] w-px"
            aria-hidden
          />

          {notes.map((note, index) => {
            const isOpen = expanded === note.id
            const long = note.note.length > 180
            // Numbered chronologically so an entry keeps its number as new
            // ones arrive; the list itself stays newest-first for scanning.
            const ordinal = notes.length - index
            return (
              <li key={note.id} className="group/note flex gap-2.5 pb-3.5 last:pb-0">
                <RailMarker ordinal={ordinal} latest={index === 0} kind={note.kind} />

                <div className="min-w-0 flex-1 pt-[2px]">
                  <div className="flex items-baseline gap-2 text-[11px]">
                    <span
                      className={cn('font-medium', KIND_STYLE[note.kind] ?? 'text-fg-subtle')}
                    >
                      {note.kind}
                    </span>
                    <span
                      className={note.actor_type === 'agent' ? 'text-accent' : 'text-fg-subtle'}
                    >
                      {note.actor_type === 'agent' ? note.actor_id : 'you'}
                    </span>
                    <RelativeTime
                      iso={note.created_at}
                      className="text-fg-subtle tabular ml-auto shrink-0"
                    />
                  </div>

                  <div
                    className={cn(
                      'mt-0.5 text-[13px]',
                      !isOpen && long && 'line-clamp-3',
                    )}
                  >
                    <MarkdownView>{note.note}</MarkdownView>
                  </div>

                  {long && (
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : note.id)}
                      className="text-fg-subtle hover:text-fg mt-0.5 text-[11px] transition-colors"
                    >
                      {isOpen ? 'Show less' : 'Show more'}
                    </button>
                  )}

                  {note.facts && note.facts.length > 0 && (
                    <ul className="text-fg-muted mt-1.5 flex flex-col gap-0.5 text-[12px]">
                      {note.facts.map((f) => (
                        <li key={f} className="flex gap-1.5">
                          <span className="text-fg-subtle select-none">·</span>
                          <span className="min-w-0">{f}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

    </section>
  )
}
