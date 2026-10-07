'use client'

import { RelativeTime } from '@/components/relative-time'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { NOTE_KINDS, type NoteKind } from '@/schemas/task'
import { Button, Select, Textarea } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import type { Note } from '@/lib/data'
import { useMutate } from '@/lib/api/use-mutate'
import { COUNT, LABEL } from './styles'

/**
 * Each kind's colour, as a token so the label and its stone share it. Dead
 * ends recede; what was found and what was decided carry the light.
 */
const KIND_TONE: Record<string, string> = {
  finding: 'var(--status-in-review)',
  decision: 'var(--accent)',
  attempt: 'var(--fg-subtle)',
  handoff: 'var(--status-doing)',
  note: 'var(--fg-muted)',
}

const toneOf = (kind: string) => KIND_TONE[kind] ?? 'var(--fg-subtle)'

/**
 * The trail between two stones: dots, not a rule, so the log reads as a path
 * walked rather than a table. Drawn per entry, so it settles in with the entry
 * it leads to.
 */
const TRAIL: React.CSSProperties = {
  backgroundImage:
    'radial-gradient(circle, color-mix(in oklab, var(--fg-subtle) 55%, transparent) 0.75px, transparent 1.15px)',
  backgroundSize: '2px 5px',
  backgroundRepeat: 'repeat-y',
}

/** The stone for one entry: a solid dot in its kind's colour. */
const Stone = ({ kind }: { kind: string }) => (
  <span
    className="relative z-10 mt-[0.3rem] block h-[0.4375rem] w-[0.625rem] shrink-0 rounded-full"
    style={{ backgroundColor: toneOf(kind) }}
    title={kind}
  />
)

/**
 * The work log, rendered dense and collapsed by default. This is the debugging
 * trail — attempts and dead ends included, because "tried X, no difference" is
 * what stops the next agent repeating it.
 */
export const NotesPanel = ({ taskId, notes: initial }: { taskId: string; notes: Note[] }) => {
  const router = useRouter()
  const request = useMutate()
  // Appended locally on submit rather than re-rendering the whole page.
  // router.refresh() re-runs every server component on the route, which is
  // needless work for "add one row to a list" and very noticeable when the
  // host is under load.
  const [notes, setNotes] = useState(initial)
  // A useState initialiser is read once, at mount. Without this the panel kept
  // its mount-time snapshot for the life of the page: an agent writing a
  // finding moved tasks.updated_at (migration 008), the pulse changed, the
  // stream fired and `router.refresh()` re-rendered the server component with
  // the new notes — which this component then ignored. Reconciled during
  // render, the pattern React documents for "adjust state when a prop
  // changes", and the one cross-project-board.tsx already uses.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setNotes(initial)
  }
  const [text, setText] = useState('')
  const [kind, setKind] = useState<NoteKind>('note')
  const [pending, setPending] = useState(false)
  // A set, not one id. Holding a single id meant expanding one entry
  // collapsed whichever was already open — reading two findings side by side
  // was impossible, which is the main thing anyone does with a work log.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allLong = notes.filter((n) => n.note.length > 180).map((n) => n.id)
  const anyCollapsed = allLong.some((id) => !expanded.has(id))

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const result = await request<Note & { duplicate?: boolean }>(
      `/api/v1/tasks/${taskId}/notes`,
      { method: 'POST', body: { note: text.trim(), kind } },
    )
    setPending(false)
    // The toast carries the reason, and the draft stays where it was typed.
    if (!result.ok) return

    const created = result.data
    setText('')

    if (created?.duplicate) return // identical note already recorded
    if (created?.id) {
      setNotes((current) => [created, ...current])
    } else {
      router.refresh() // unexpected shape; fall back to a reload
    }
  }

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2.5 flex items-center gap-2')}>
        Work log
        <span className={COUNT}>{notes.length}</span>
        {allLong.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(anyCollapsed ? new Set(allLong) : new Set())}
            className="ml-auto tracking-normal normal-case"
          >
            {anyCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}
      </h2>

      {/* A field, with its controls on a row of their own beneath it: the same
          textarea as everywhere else, and a compact select and button that
          share one height. */}
      <div className="mb-4 flex flex-col gap-2">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="What did you try, find, or decide? Dead ends count."
          aria-label="Add a note"
          className="max-h-[40vh] w-full"
        />

        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 h-[0.375rem] w-[0.5rem] rounded-full transition-colors duration-[var(--dur-1)]"
              style={{ backgroundColor: toneOf(kind) }}
            />
            <Select
              size="sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as NoteKind)}
              aria-label="Note kind"
              className="pl-7"
              style={{ color: toneOf(kind) }}
            >
              {NOTE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>

          <span className="text-fg-subtle ml-auto hidden text-meta sm:block">
            <kbd className="kbd inline-flex">⌘</kbd>
            <kbd className="kbd ml-0.5 inline-flex">↵</kbd>
          </span>

          <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim() || pending}>
            {pending ? <Spinner /> : 'Add note'}
          </Button>
        </div>
      </div>

      {notes.length === 0 ? (
        <EmptyState compact title="Nothing logged yet." hint="Dead ends are worth recording too." />
      ) : (
        // A trail rather than a divided list: a divided list of boxes reads
        // as a table, and this is a sequence. The newest entries settle in.
        <ol className="stagger flex flex-col">
          {notes.map((note, index) => {
            const isOpen = expanded.has(note.id)
            const long = note.note.length > 180
            // Numbered chronologically so an entry keeps its number as new
            // ones arrive; the list itself stays newest-first for scanning.
            const ordinal = notes.length - index
            return (
              <li key={note.id} className="group/note relative flex gap-3 pb-3.5 last:pb-0">
                <Stone kind={note.kind} />
                {/* To the next stone down; the oldest entry is the trailhead. */}
                <span
                  aria-hidden
                  className="absolute top-[0.9375rem] bottom-[-0.125rem] left-[0.25rem] w-[2px] group-last/note:hidden"
                  style={TRAIL}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-meta">
                    <span className="font-medium" style={{ color: toneOf(note.kind) }}>
                      {note.kind}
                    </span>
                    <span
                      className={note.actor_type === 'agent' ? 'text-accent' : 'text-fg-subtle'}
                    >
                      {note.actor_id}
                    </span>
                    <span className="text-fg-subtle/80 tabular ml-auto shrink-0" title={`Entry ${ordinal}`}>
                      #{ordinal}
                    </span>
                    <RelativeTime iso={note.created_at} className="text-fg-subtle tabular shrink-0" />
                  </div>

                  <div
                    className={cn(
                      'mt-0.5 text-ui',
                      !isOpen && long && 'line-clamp-3',
                    )}
                  >
                    <MarkdownView>{note.note}</MarkdownView>
                  </div>

                  {long && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(note.id)}
                      className="text-fg-subtle hover:text-fg mt-0.5 text-meta transition-colors duration-[var(--dur-1)]"
                    >
                      {isOpen ? 'Show less' : 'Show more'}
                    </button>
                  )}

                  {note.facts && note.facts.length > 0 && (
                    <ul className="text-fg-muted mt-1.5 flex flex-col gap-0.5 text-meta">
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
