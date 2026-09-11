'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search as SearchIcon } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { Select } from '@/components/ui/control'

/**
 * Filters live in the URL, same as /search — a filtered view is then a link
 * you can paste to someone else, not a client state that resets on reload.
 */
export const KnowledgeControls = ({
  q,
  project,
  entity,
  label,
  superseded,
  projects,
  entities,
  labels,
}: {
  q: string
  project: string
  entity: string
  label: string
  superseded: boolean
  projects: { key: string; title: string }[]
  entities: { key: string; title: string }[]
  labels: string[]
}) => {
  const router = useRouter()
  const [running, startTransition] = useTransition()
  const [draft, setDraft] = useState(q)
  const committed = useRef(q)
  const inputRef = useRef<HTMLInputElement>(null)

  const push = (next: Partial<{ q: string; project: string; entity: string; label: string; superseded: boolean }>) => {
    const merged = { q: draft, project, entity, label, superseded, ...next }
    const params = new URLSearchParams()
    if (merged.q) params.set('q', merged.q)
    if (merged.project) params.set('project', merged.project)
    if (merged.entity) params.set('entity', merged.entity)
    if (merged.label) params.set('label', merged.label)
    if (merged.superseded) params.set('superseded', '1')
    committed.current = merged.q ?? ''
    startTransition(() => router.replace(`/knowledge?${params.toString()}`))
  }

  useEffect(() => {
    if (draft === committed.current) return
    const timer = setTimeout(() => push({ q: draft }), 260)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const pendingDebounce = draft.trim() !== q.trim()
  const searching = q.trim().length >= 2

  return (
    <div className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-[280px]">
        <span className="text-fg-subtle grid size-[14px] shrink-0 place-items-center">
          {running || pendingDebounce ? <Spinner size={13} /> : <SearchIcon size={13} aria-hidden />}
        </span>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft('')}
          placeholder="Search knowledge…"
          aria-label="Search knowledge"
          className="text-fg placeholder:text-fg-subtle min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>

      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        <Select
          size="sm"
          value={project}
          onChange={(e) => push({ project: e.target.value })}
          aria-label="Filter by project"
          className="w-auto"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title}
            </option>
          ))}
        </Select>

        <Select
          size="sm"
          value={entity}
          onChange={(e) => push({ entity: e.target.value })}
          disabled={searching}
          title={searching ? 'Clear the search to filter by entity' : undefined}
          aria-label="Filter by entity"
          className="w-auto"
        >
          <option value="">All entities</option>
          {entities.map((e) => (
            <option key={e.key} value={e.key}>
              {e.title}
            </option>
          ))}
        </Select>

        <Select
          size="sm"
          value={label}
          onChange={(e) => push({ label: e.target.value })}
          aria-label="Filter by label"
          className="w-auto"
        >
          <option value="">Any label</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>

        <label className="text-fg-muted flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap">
          <input
            type="checkbox"
            checked={superseded}
            onChange={(e) => push({ superseded: e.target.checked })}
            className="accent-accent size-[13px]"
          />
          Show superseded
        </label>

        {(q || project || entity || label || superseded) && (
          <button
            type="button"
            onClick={() => {
              setDraft('')
              committed.current = ''
              router.replace('/knowledge')
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
