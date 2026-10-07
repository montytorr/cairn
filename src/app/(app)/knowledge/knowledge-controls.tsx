'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search as SearchIcon } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { Button, Checkbox, Input, Select } from '@/components/ui/control'

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
    <div className="border-border/70 flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center sm:px-4">
      <div className="relative flex min-w-0 flex-1 items-center sm:max-w-[17.5rem]">
        <span className="text-fg-subtle pointer-events-none absolute left-2 z-10 grid size-[0.875rem] place-items-center">
          {running || pendingDebounce ? <Spinner size={13} /> : <SearchIcon size={13} aria-hidden />}
        </span>
        <Input
          ref={inputRef}
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft('')}
          placeholder="Search knowledge…"
          aria-label="Search knowledge"
          className="min-w-0 flex-1 pl-8"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          value={project}
          onChange={(e) => push({ project: e.target.value })}
          aria-label="Filter by project"
          className="max-w-[14rem]"
          emptyLabel={projects.length === 0 ? 'No projects yet' : undefined}
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
          // Blank while searching, not merely disabled. `search_all` takes no
          // entity, so the filter genuinely is not applied — and a URL
          // carrying both showed the entity greyed out but still named, which
          // reads as "applied, just locked" rather than "ignored".
          value={searching ? '' : entity}
          onChange={(e) => push({ entity: e.target.value })}
          disabled={searching}
          title={searching ? 'Clear the search to filter by entity' : undefined}
          aria-label="Filter by entity"
          className="max-w-[14rem]"
          emptyLabel={entities.length === 0 ? 'No entities yet' : undefined}
        >
          <option value="">{searching ? 'Not used while searching' : 'All entities'}</option>
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
          className="max-w-[14rem]"
          emptyLabel={labels.length === 0 ? 'No labels yet' : undefined}
        >
          <option value="">Any label</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>

        <Checkbox
          checked={superseded}
          onChange={(e) => push({ superseded: e.target.checked })}
          label="Show superseded"
          labelClassName="shrink-0 whitespace-nowrap"
        />

        {(q || project || entity || label || superseded) && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setDraft('')
              committed.current = ''
              router.replace('/knowledge')
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}
