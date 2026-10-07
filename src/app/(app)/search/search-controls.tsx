'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'
import { Spinner } from '@/components/spinner'
import { Search as SearchIcon, X } from 'lucide-react'
import { Button, Input, Select } from '@/components/ui/control'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const Filter = ({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: { value: string; label: string }[]
}) => (
  <Select
    size="sm"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    aria-label={placeholder}
    className={cn('max-w-[14rem]', value ? 'text-fg' : 'text-fg-subtle')}
  >
    <option value="">{placeholder}</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </Select>
)

/**
 * The query lives in the URL so a search can be linked to and shared — which
 * is the difference between a lookup and a citable answer. The input is
 * debounced into it rather than pushed per keystroke.
 */
export const SearchControls = ({
  q,
  project,
  type,
  status,
  kind,
  projects,
}: {
  q: string
  project: string
  type: string
  status: string
  kind: string
  projects: { key: string; title: string }[]
}) => {
  const router = useRouter()
  // The query lives in the URL, so every keystroke is a server round trip.
  // Without this the page sat completely still while it ran — a searchParams
  // change does not reliably surface loading.tsx, so the feedback has to come
  // from the control that started it.
  const [running, startSearch] = useTransition()
  const [draft, setDraft] = useState(q)
  const inputRef = useRef<HTMLInputElement>(null)
  // The committed query, so the debounce does not re-push the URL it just
  // arrived from.
  const committed = useRef(q)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const push = (next: {
    q?: string
    project?: string
    type?: string
    status?: string
    kind?: string
  }) => {
    const params = new URLSearchParams()
    const merged = { q: draft, project, type, status, kind, ...next }
    // Type and status only mean anything for tasks, so choosing another kind
    // drops them rather than silently returning nothing.
    if (merged.kind && merged.kind !== 'all' && merged.kind !== 'task') {
      merged.type = ''
      merged.status = ''
    }
    if (merged.kind === 'all') merged.kind = ''
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value)
    }
    committed.current = merged.q ?? ''
    startSearch(() => router.replace(`/search?${params.toString()}`))
  }

  useEffect(() => {
    if (draft === committed.current) return
    const timer = setTimeout(() => push({ q: draft }), 260)
    return () => clearTimeout(timer)
    // `push` closes over the current filters; re-creating it each render is
    // fine because only `draft` drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // True between the last keystroke and the URL catching up, so the spinner
  // appears immediately rather than after the debounce. Compared against the
  // `q` prop, not the ref: a ref read during render neither re-renders when it
  // changes nor is sound under concurrent rendering.
  const pendingDebounce = draft.trim() !== q.trim()
  const cleared = !q && !project && !type && !status && (!kind || kind === 'all')

  return (
    <div className="border-border/70 flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:h-[2.625rem] sm:flex-row sm:items-center sm:px-4 sm:py-0">
      {/* The one field on the page that matters, so it is drawn as a field:
          a well whose rim turns to the accent on focus, rather than bare text on the
          bar that only a blinking caret distinguished from a label. */}
      <div className="relative flex min-w-0 flex-1 items-center sm:min-w-[16rem]">
        <span
          className={cn(
            'pointer-events-none absolute left-2.5 z-10 grid size-[0.875rem] place-items-center transition-colors duration-[var(--dur-1)]',
            draft ? 'text-accent' : 'text-fg-subtle',
          )}
        >
          {running || pendingDebounce ? <Spinner size={13} /> : <SearchIcon size={13} aria-hidden />}
        </span>
        <Input
          ref={inputRef}
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft('')
          }}
          placeholder="Has this already been done or debugged?"
          aria-label="Search tasks"
          className="min-w-0 flex-1 pr-10 pl-8 sm:pr-2.5"
        />
        {draft && (
          <Button
            icon
            size="sm"
            variant="ghost"
            onClick={() => setDraft('')}
            aria-label="Clear the search"
            className="absolute right-0 z-10 sm:hidden"
          >
            <X size={14} aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
      <Filter
        value={kind === 'all' ? '' : kind}
        onChange={(v) => push({ kind: v || 'all' })}
        placeholder="Everything"
        options={[
          { value: 'task', label: 'Tasks' },
          { value: 'note', label: 'Work-log notes' },
          { value: 'knowledge', label: 'Knowledge' },
          { value: 'session', label: 'Sessions' },
        ]}
      />
      <Filter
        value={project}
        onChange={(v) => push({ project: v })}
        placeholder="All projects"
        options={projects.map((p) => ({ value: p.key, label: p.title }))}
      />
      {(kind === 'all' || kind === 'task') && (
        <>
          <Filter
            value={type}
            onChange={(v) => push({ type: v })}
            placeholder="Any type"
            options={TASK_TYPES.map((t) => ({ value: t, label: t }))}
          />
          <Filter
            value={status}
            onChange={(v) => push({ status: v })}
            placeholder="Any status"
            options={TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s }))}
          />
        </>
      )}
      {!cleared && (
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            setDraft('')
            committed.current = ''
            router.replace('/search')
          }}
        >
          Clear
        </Button>
      )}
      </div>
    </div>
  )
}
