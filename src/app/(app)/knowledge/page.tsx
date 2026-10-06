import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LiveUpdates } from '@/components/live-updates'
import Link from 'next/link'
import { ChevronRight, Info, Waypoints } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { countKnowledge, listKnowledge, supersededByInfo } from '@/lib/api/knowledge'
import { listEntities } from '@/lib/api/entities'
import { searchAll } from '@/lib/api/search'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { BrandName } from '@/components/brand'
import { EmptyState } from '@/components/empty-state'
import { KnowledgeControls } from './knowledge-controls'
import { KnowledgeList, type KnowledgeListItem } from './knowledge-list'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Knowledge' }

/**
 * One page of the corpus.
 *
 * Was 300, which the corpus had already outgrown — 81 entries existed that this
 * page would not show and did not admit to hiding. Raised well clear of it, and
 * the true total is now counted separately and printed, so the header states
 * the size of the corpus rather than the size of the fetch.
 */
const PAGE = 1000

const KnowledgePage = async ({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    project?: string
    entity?: string
    label?: string
    superseded?: string
  }>
}) => {
  const { q = '', project = '', entity = '', label = '', superseded } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const includeSuperseded = superseded === '1'
  const query = q.trim()

  // Fetched regardless of the active filters: it is the source of the label
  // vocabulary offered in the filter itself, which must not shrink to only
  // the labels already matching the current filter.
  const [projects, entities, universe, total] = await Promise.all([
    listProjects(user.id),
    listEntities(user.id),
    listKnowledge(user.id, { limit: PAGE, includeSuperseded: true }),
    countKnowledge({ includeSuperseded }),
  ])
  const labelUniverse = [...new Set(universe.flatMap((r) => r.labels))].sort()

  let items: KnowledgeListItem[] = []
  let failure: string | null = null
  let widened = false
  // Whether what is on screen is a narrowing of the corpus rather than all of it.
  const narrowed = query.length >= 2 || Boolean(project || entity || label)

  const entityKeys = new Set(entities.map((e) => e.key))

  if (query.length >= 2) {
    try {
      const { rows, widened: w } = await searchAll(
        user.id,
        query,
        { project: project || undefined, kinds: ['knowledge'] },
        60,
      )
      widened = w
      items = rows
        .map((r) => ({
          slug: r.ref,
          title: r.title,
          labels: r.subtitle ? r.subtitle.split(',').map((s) => s.trim()) : [],
          // `search_all` packs entity keys into `project_key` when a row has
          // no projects (migration 020), with nothing to say which it is —
          // so an entity-scoped fact arrived here and was drawn as a project,
          // coloured hexagon and all. The entity list is already loaded for
          // the filter above, and it is the only thing that can tell them
          // apart.
          projects: (r.project_key ? r.project_key.split(',') : []).filter(
            (k) => !entityKeys.has(k),
          ),
          entities: (r.project_key ? r.project_key.split(',') : []).filter((k) =>
            entityKeys.has(k),
          ),
          verified: r.answered,
          updatedAt: r.updated_at,
          superseded: r.status === 'superseded',
          // search_all does not carry the replacement's id, only that this
          // row was superseded — so there is nothing here to link to.
          supersededByRef: null,
          loose: r.widened,
        }))
        .filter((r) => (label ? r.labels.includes(label) : true))
        .filter((r) => (includeSuperseded ? true : !r.superseded))
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Search failed.'
    }
  } else {
    const scoped =
      project || entity || label
        ? await listKnowledge(user.id, {
            project: project || undefined,
            entity: entity || undefined,
            label: label || undefined,
            limit: PAGE,
            includeSuperseded,
          })
        : universe.filter((r) => !includeSuperseded ? !r.superseded_by : true)

    // The entity narrowing is done by listKnowledge, in the query. Doing it
    // here would filter an already-limited page, which is correct only while
    // the corpus is smaller than the limit.
    const rows = scoped
    const supersededMap = await supersededByInfo(
      user.id,
      rows.map((r) => r.superseded_by).filter((id): id is string => Boolean(id)),
    )

    items = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      labels: r.labels,
      projects: r.projects ?? [],
      entities: r.entities ?? [],
      verified: Boolean(r.verified_at),
      updatedAt: r.updated_at,
      superseded: Boolean(r.superseded_by),
      supersededByRef: r.superseded_by ? (supersededMap.get(r.superseded_by) ?? null) : null,
    }))
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* agents write knowledge while you are reading it */}
      <LiveUpdates />
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[0.8125rem] transition-colors sm:block"
        >
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-[0.8125rem]">Knowledge</span>
        {/* The size of the corpus, not the size of the fetch. When a filter or
            a search is narrowing it, say so against the whole — "12 of 381"
            answers a different question from "12" and is the one being asked.
            And if the page ever caps again, admit it rather than silently
            showing a prefix. */}
        <span className="text-fg-subtle ml-auto hidden text-[0.75rem] tabular-nums sm:block">
          {narrowed
            ? `${items.length} of ${total} ${total === 1 ? 'entry' : 'entries'}`
            : `${total} ${total === 1 ? 'entry' : 'entries'}`}
          {!narrowed && items.length < total ? ` · showing first ${items.length}` : ''}
          {widened ? ' · loose match' : ''}
        </span>
        {/* The only way into the map, and it used to be one unlined word in the
            same grey as the count beside it — indistinguishable from static
            metadata, on a 26px target, with no entry in the sidebar either.
            Given a border and an icon it reads as a control, which is what it
            is. */}
        <Link
          href="/knowledge/graph"
          className="border-border bg-surface text-fg-muted hover:text-fg hover:border-border-strong hover:bg-surface-raised ml-3 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition-colors duration-[var(--dur-1)]"
        >
          <Waypoints size={13} aria-hidden />
          Map
        </Link>
      </header>

      <KnowledgeControls
        q={q}
        project={project}
        entity={entity}
        label={label}
        superseded={includeSuperseded}
        projects={projects.map((p) => ({ key: p.key, title: p.title }))}
        entities={entities.map((e) => ({ key: e.key, title: e.title }))}
        labels={labelUniverse}
      />

      {/* The scope column is the only thing on this page that needs explaining,
          and "entity" means nothing to someone meeting it here for the first
          time. Said once, at the top, rather than in a tooltip nobody opens. */}
      {!query && (
        <p className="border-border/70 text-fg-subtle flex items-start gap-2 border-b px-4 py-2 text-[0.71875rem] leading-relaxed">
          <Info size={12} className="mt-[0.1875rem] shrink-0 opacity-70" aria-hidden />
          <span>
            Scope is how widely a fact applies:{' '}
            <span className="text-fg-muted">a project</span> (true of that codebase),{' '}
            <span className="text-fg-muted">an entity</span> — a grouping a fact can be true
            of, like a business, a stack or a subsystem — or{' '}
            <span className="text-fg-muted">everywhere</span>. Narrower wins, so a project
            fact is shown ahead of one that merely applies to it.
          </span>
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {failure ? (
          <p className="text-danger px-4 py-8 text-[0.8125rem]">{failure}</p>
        ) : items.length === 0 ? (
          <EmptyState
            title={query ? `Nothing found for "${query}".` : 'No knowledge matches these filters.'}
          />
        ) : (
          <KnowledgeList items={items} />
        )}
      </div>
    </div>
  )
}

export default KnowledgePage
