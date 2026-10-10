'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { ChevronRight, Plus, Search, X } from 'lucide-react'
import { BrandName } from '@/components/brand'
import { EmptyState } from '@/components/empty-state'
import { FilterMenu } from '@/components/filter-menu'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { usePeople } from '@/components/people-context'
import { Spinner } from '@/components/spinner'
import { Button, Checkbox, Input, Select } from '@/components/ui/control'
import { ViewToggle } from '@/app/(app)/projects/[key]/view-switch'
import { viewCookieName, type ProjectView } from '@/lib/project-view'
import { CreateSubjectDialog } from './create-subject'
import { hasFilters, labUrl, type LabFilters } from './filters'
import { LabBoard } from './lab-board'
import { LabList } from './lab-list'
import {
  CATEGORY_FILTER_LABEL, STAGE_CATEGORIES, type ProjectRef, type Stage, type SubjectSummary, type Tag,
} from './types'

/** The list-or-board choice, remembered per browser as a project's is. */
export const LAB_VIEW_COOKIE = viewCookieName('lab')

// Secure wherever the page itself is served over HTTPS; plain http is only
// ever local development, where a Secure cookie would never be stored.
const rememberView = (view: ProjectView) => {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${LAB_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax${secure}`
}

const Divider = () => <span className="bg-border mx-0.5 h-[1rem] w-px shrink-0" aria-hidden />

/**
 * The Lab: every subject, as a list grouped by stage or as a board of stage
 * lanes. Filters are the URL's; the text filter follows typing a beat behind.
 */
export const LabView = ({
  subjects,
  stages,
  tags,
  projects,
  initialView,
  filters,
}: {
  subjects: SubjectSummary[]
  stages: Stage[]
  tags: Tag[]
  projects: ProjectRef[]
  initialView: ProjectView | null
  filters: LabFilters
}) => {
  const router = useRouter()
  const { people, currentUserId } = usePeople()
  const [view, setView] = useState<ProjectView>(initialView ?? 'list')
  const [from, setFrom] = useState<ProjectView | null>(null)
  const [query, setQuery] = useState(filters.q)
  const [running, startTransition] = useTransition()
  const [creating, setCreating] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  const navigate = useCallback(
    (next: LabFilters) => startTransition(() => router.replace(labUrl(next), { scroll: false })),
    [router],
  )
  const closeCreate = useCallback(() => setCreating(false), [])

  // The text filter, a beat behind typing.
  useEffect(() => {
    if (query.trim() === filters.q) return
    const timer = setTimeout(() => navigate({ ...filters, q: query.trim() }), 280)
    return () => clearTimeout(timer)
  }, [query, filters, navigate])

  // `/` focuses the filter, as it does on every list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      ) {
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const pickView = (next: ProjectView) => {
    if (next !== view) setFrom(view)
    setView(next)
    rememberView(next)
  }

  const stageOptions = useMemo(() => stages.map((s) => ({ value: s.name, label: s.name })), [stages])
  const categoryOptions = useMemo(
    () => STAGE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_FILTER_LABEL[c] })),
    [],
  )
  const tagOptions = useMemo(() => tags.map((t) => ({ value: t.name, label: t.name })), [tags])
  const projectOptions = useMemo(
    () => [
      { value: 'none', label: 'No project' },
      ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.title}` })),
    ],
    [projects],
  )
  const ownerOptions = useMemo(
    () => people.filter((p) => p.active && p.id !== currentUserId),
    [people, currentUserId],
  )

  const filtered = hasFilters(filters)
  const active = subjects.filter((s) => s.stage.category === 'active').length
  const planned = subjects.filter((s) => s.stage.category === 'planned').length
  const concluded = subjects.length - active - planned

  const toggle = (
    <ViewToggle view={view} from={from} onPick={pickView} />
  )

  return (
    <div className="flex h-full flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg hidden text-ui transition-colors sm:block">
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-ui">Lab</span>
        <p className="text-fg-subtle tabular ml-2 hidden items-center gap-3 text-meta xl:flex">
          <span><span className="text-fg-muted font-medium">{active}</span> active</span>
          <span><span className="text-fg-muted font-medium">{planned}</span> ideas</span>
          <span><span className="text-fg-muted font-medium">{concluded}</span> concluded</span>
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden />
            <span className="hidden sm:inline">New subject</span>
          </Button>
        </div>
      </header>

      <div className="border-border flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        {toggle}
        <Divider />
        <label className="relative flex w-full items-center sm:w-[14rem]">
          <Search size={13} aria-hidden className="text-fg-subtle pointer-events-none absolute left-2.5 z-10" />
          <Input
            ref={search}
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Filter subjects…"
            aria-label="Filter subjects"
            className="pr-8 pl-8"
          />
          {running ? (
            <span className="text-fg-subtle absolute right-2.5">
              <Spinner size={11} />
            </span>
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear the filter"
              className="text-fg-subtle hover:text-fg absolute right-2"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </label>

        <FilterMenu
          label="Category"
          options={categoryOptions}
          selected={filters.category}
          onChange={(next) => navigate({ ...filters, category: next as LabFilters['category'] })}
        />
        <FilterMenu
          label="Stage"
          options={stageOptions}
          selected={filters.stage}
          onChange={(next) => navigate({ ...filters, stage: next })}
        />
        {tagOptions.length > 0 ? (
          <FilterMenu
            label="Tag"
            options={tagOptions}
            selected={filters.tag}
            onChange={(next) => navigate({ ...filters, tag: next })}
          />
        ) : null}
        <FilterMenu
          label="Project"
          options={projectOptions}
          selected={filters.project}
          onChange={(next) => navigate({ ...filters, project: next })}
        />
        <Select
          size="sm"
          value={filters.owner}
          onChange={(e) => navigate({ ...filters, owner: e.target.value })}
          aria-label="Owner"
          className="w-[8.5rem]"
        >
          <option value="">Anyone</option>
          {currentUserId ? <option value="me">Me</option> : null}
          {ownerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Checkbox
          label="Archived"
          checked={filters.archived}
          onChange={(e) => navigate({ ...filters, archived: e.target.checked })}
          labelClassName="px-1"
        />

        {filtered ? (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setQuery('')
              navigate({ stage: [], category: [], tag: [], owner: '', project: [], q: '', archived: false })
            }}
            className="ml-auto"
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {stages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            as="h2"
            title="No stages yet"
            hint="An administrator sets the Lab's stages in Settings: the pipeline every subject moves along."
          />
        </div>
      ) : subjects.length === 0 && !filtered ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            as="h2"
            title="Nothing in the Lab yet"
            hint="A subject is anything worth finding out about: a technology to try, a proof of concept, an idea to build."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} aria-hidden /> New subject
              </Button>
            }
          />
        </div>
      ) : view === 'board' ? (
        <div className="min-h-0 flex-1">
          <LabBoard subjects={subjects} stages={stages} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {subjects.length === 0 ? (
            <EmptyState compact title="No subject matches these filters." />
          ) : (
            <LabList subjects={subjects} stages={stages} />
          )}
        </div>
      )}

      {creating ? <CreateSubjectDialog stages={stages} onClose={closeCreate} /> : null}
    </div>
  )
}
