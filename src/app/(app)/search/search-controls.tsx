'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

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
  <div className="relative shrink-0">
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={placeholder}
      className={`border-border bg-bg hover:bg-surface-hover h-[26px] cursor-pointer appearance-none [-webkit-appearance:none] rounded-md border pr-6 pl-2 text-[12px] outline-none transition-colors ${
        value ? 'text-fg' : 'text-fg-subtle'
      }`}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
    <svg
      className="text-fg-subtle pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2"
      width="9"
      height="9"
      viewBox="0 0 9 9"
      aria-hidden
    >
      <path d="M1.5 3.2L4.5 6 7.5 3.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  </div>
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
  projects,
}: {
  q: string
  project: string
  type: string
  status: string
  projects: { key: string; title: string }[]
}) => {
  const router = useRouter()
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
  }) => {
    const params = new URLSearchParams()
    const merged = { q: draft, project, type, status, ...next }
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value)
    }
    committed.current = merged.q ?? ''
    router.replace(`/search?${params.toString()}`)
  }

  useEffect(() => {
    if (draft === committed.current) return
    const timer = setTimeout(() => push({ q: draft }), 260)
    return () => clearTimeout(timer)
    // `push` closes over the current filters; re-creating it each render is
    // fine because only `draft` drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const cleared = !q && !project && !type && !status

  return (
    <div className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:h-[42px] sm:flex-row sm:items-center sm:px-4 sm:py-0">
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft('')
        }}
        placeholder="Has this already been done or debugged?"
        aria-label="Search tasks"
        className="text-fg placeholder:text-fg-subtle min-w-0 flex-1 bg-transparent text-[13px] outline-none"
      />
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      <Filter
        value={project}
        onChange={(v) => push({ project: v })}
        placeholder="All projects"
        options={projects.map((p) => ({ value: p.key, label: p.title }))}
      />
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
      {!cleared && (
        <button
          type="button"
          onClick={() => {
            setDraft('')
            committed.current = ''
            router.replace('/search')
          }}
          className="text-fg-subtle hover:text-fg shrink-0 whitespace-nowrap text-[12px] transition-colors"
        >
          Clear
        </button>
      )}
      </div>
    </div>
  )
}
