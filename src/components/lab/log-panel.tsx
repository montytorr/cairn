'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Avatar } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { MarkdownView } from '@/components/markdown'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { Button, Checkbox, Select, Textarea } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import type { SubjectNote } from './types'

/** What a caller may write. `stage` is the server's, written with every move. */
export const LOG_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff'] as const

/** Dead ends recede; what was found and what was decided carry the colour. */
const KIND_TONE: Record<string, string> = {
  finding: 'var(--status-in-review)',
  decision: 'var(--accent)',
  attempt: 'var(--fg-subtle)',
  handoff: 'var(--status-doing)',
  stage: 'var(--fg-subtle)',
  note: 'var(--fg-muted)',
}

const toneOf = (kind: string) => KIND_TONE[kind] ?? 'var(--fg-subtle)'

/**
 * The log: append-only, newest first. Findings, decisions and attempts
 * (including the dead ends, because "tried X, no difference" is what stops the
 * next person repeating it), with the stage moves the server writes in between.
 */
export const LogPanel = ({ subjectRef, notes }: { subjectRef: string; notes: SubjectNote[] }) => {
  const router = useRouter()
  const request = useMutate()
  const [text, setText] = useState('')
  const [kind, setKind] = useState<(typeof LOG_KINDS)[number]>('note')
  const [pending, setPending] = useState(false)
  const [showStages, setShowStages] = useState(true)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const result = await request(`/api/v1/subjects/${subjectRef}/notes`, {
      method: 'POST',
      body: { note: text.trim(), kind },
    })
    setPending(false)
    if (!result.ok) return
    setText('')
    router.refresh()
  }

  const shown = showStages ? notes : notes.filter((n) => n.kind !== 'stage')

  return (
    <section aria-label="Log" className="max-w-[51.25rem]">
      <div className="mb-4 flex flex-col gap-2">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder="Record what was tried, found or decided…"
          aria-label="Add to the log"
          className="max-h-[40vh] w-full"
        />
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof LOG_KINDS)[number])}
            aria-label="Kind"
            className="w-32"
          >
            {LOG_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Checkbox
            label="Stage moves"
            checked={showStages}
            onChange={(e) => setShowStages(e.target.checked)}
            labelClassName="ml-auto"
          />
          <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!text.trim() || pending}>
            {pending ? <Spinner /> : 'Add to log'}
          </Button>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState compact title="Nothing logged yet." />
      ) : (
        <ol className="stagger flex flex-col">
          {shown.map((n) => (
            <li key={n.id} className="border-border flex gap-3 border-b py-2.5 last:border-b-0">
              <span
                aria-hidden
                className="mt-[0.4rem] block size-[0.4375rem] shrink-0 rounded-full"
                style={{ backgroundColor: toneOf(n.kind) }}
              />
              <div className="min-w-0 flex-1">
                <p className="mb-0.5 flex flex-wrap items-center gap-x-2 text-meta">
                  <span className="font-medium" style={{ color: toneOf(n.kind) }}>
                    {n.kind}
                  </span>
                  <span className="text-fg-muted flex items-center gap-1.5">
                    <Avatar name={n.actor_id} size={14} />
                    <span className={cn(n.actor_type === 'agent' && 'text-accent')}>{n.actor_id}</span>
                  </span>
                  <RelativeTime iso={n.created_at} className="text-fg-subtle ml-auto" />
                </p>
                {n.kind === 'stage' ? (
                  <p className="text-fg-muted text-ui">{n.note}</p>
                ) : (
                  <MarkdownView>{n.note}</MarkdownView>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
