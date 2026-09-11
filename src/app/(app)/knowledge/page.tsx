import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { listKnowledge, supersededByInfo } from '@/lib/api/knowledge'
import { listEntities } from '@/lib/api/entities'
import { searchAll } from '@/lib/api/search'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { KnowledgeControls } from './knowledge-controls'
import { KnowledgeList, type KnowledgeListItem } from './knowledge-list'

export const dynamic = 'force-dynamic'

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
  const [projects, entities, universe] = await Promise.all([
    listProjects(user.id),
    listEntities(user.id),
    listKnowledge(user.id, { limit: 300, includeSuperseded: true }),
  ])
  const labelUniverse = [...new Set(universe.flatMap((r) => r.labels))].sort()

  let items: KnowledgeListItem[] = []
  let failure: string | null = null
  let widened = false

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
          projects: r.project_key ? r.project_key.split(',') : [],
          entities: [] as string[],
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
            limit: 300,
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
      scope: r.scope,
      superseded: Boolean(r.superseded_by),
      supersededByRef: r.superseded_by ? (supersededMap.get(r.superseded_by) ?? null) : null,
    }))
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[13px] transition-colors sm:block"
        >
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-[13px]">Knowledge</span>
        <span className="text-fg-subtle ml-auto hidden text-[12px] sm:block">
          {items.length} {items.length === 1 ? 'entry' : 'entries'}
          {widened ? ' · loose match' : ''}
        </span>
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
        <p className="border-border text-fg-subtle border-b px-4 py-2 text-[12px] leading-relaxed">
          Scope is how widely a fact applies:{' '}
          <span className="text-fg-muted">a project</span> (true of that codebase),{' '}
          <span className="text-fg-muted">an entity</span> — a grouping a fact can be true
          of, like a business, a stack or a subsystem — or{' '}
          <span className="text-fg-muted">global</span>, true everywhere. Narrower wins, so
          a project fact is shown ahead of one that merely applies to it.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure ? (
          <p className="text-danger px-4 py-8 text-[13px]">{failure}</p>
        ) : items.length === 0 ? (
          <div className="text-fg-subtle px-4 py-12 text-center text-[13px]">
            <p>{query ? `Nothing found for "${query}".` : 'No knowledge matches these filters.'}</p>
          </div>
        ) : (
          <KnowledgeList items={items} />
        )}
      </div>
    </div>
  )
}

export default KnowledgePage
