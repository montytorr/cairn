'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import { ROW, ROW_LABEL } from '@/app/(app)/projects/[key]/tasks/[number]/styles'
import { StageIcon } from './stage'
import { subjectHref, type SubjectSummary } from './types'

type Candidate = Pick<SubjectSummary, 'id' | 'ref' | 'number' | 'title' | 'stage'>

/**
 * A task's subject, in the task page's properties: the subject it is a todo
 * of, linked, with a picker to link or move it and a way to unlink. The
 * subject is the only Lab field a task carries; it is absent entirely while
 * the Lab is off, and this row is not drawn.
 */
export const SubjectField = ({
  taskId,
  subject,
}: {
  taskId: string
  subject: { ref: string; title: string } | null
}) => {
  const router = useRouter()
  const request = useMutate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Candidate[] | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Live subjects, narrowed by what is typed, a beat behind it.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ limit: '8' })
      if (query.trim()) params.set('q', query.trim())
      try {
        const res = await fetch(`/api/v1/subjects?${params}`, { signal: controller.signal })
        const json = await res.json().catch(() => null)
        setResults(res.ok && json?.success ? (json.data as Candidate[]) : [])
      } catch {
        // aborted by the next keystroke, or offline: the list simply stays as it was
      }
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, query])

  const link = async (ref: string | null) => {
    const result = await request(`/api/v1/tasks/${taskId}`, { method: 'PATCH', body: { subject: ref } })
    if (!result.ok) return
    setOpen(false)
    router.refresh()
  }

  return (
    <div ref={wrap} className="relative">
      <div className={ROW}>
        <span className={ROW_LABEL}>Subject</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {subject ? (
            <>
              <FlaskConical size={13} aria-hidden className="text-fg-subtle shrink-0" />
              <Link
                href={subjectHref(subject.ref.replace(/^LAB-/i, ''))}
                title={subject.title}
                className="text-fg hover:text-accent min-w-0 truncate text-ui transition-colors"
              >
                <span className="font-mono">{subject.ref}</span>
                <span className="text-fg-muted"> {subject.title}</span>
              </Link>
              <Button
                icon
                size="sm"
                variant="ghost"
                aria-label="Unlink the subject"
                title="Unlink the subject"
                onClick={() => void link(null)}
                className="ml-auto"
              >
                <X size={13} aria-hidden />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="-ml-1.5"
            >
              Link to a subject
            </Button>
          )}
        </div>
        {subject ? (
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Change
          </Button>
        ) : null}
      </div>

      {open ? (
        <div
          className="border-border bg-surface pop raised absolute top-full left-0 z-50 mt-1 w-full rounded-lg border p-1"
          style={{ '--origin': 'top left' } as React.CSSProperties}
        >
          <InlineInput
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a subject…"
            aria-label="Find a subject"
            className="mb-1 w-full"
          />
          <ul role="listbox" aria-label="Subjects" className="max-h-[14rem] overflow-y-auto">
            {results === null ? (
              <li className="text-fg-subtle px-2 py-2 text-meta">Loading…</li>
            ) : results.length === 0 ? (
              <li className="text-fg-subtle px-2 py-2 text-meta">No subject matches.</li>
            ) : (
              results.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={s.ref === subject?.ref}
                    onClick={() => void link(s.ref)}
                    className="hover:bg-surface-hover flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors"
                  >
                    <StageIcon stage={s.stage} />
                    <span className="text-fg-subtle shrink-0 font-mono text-meta">{s.ref}</span>
                    <span className="text-fg min-w-0 truncate text-ui">{s.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
