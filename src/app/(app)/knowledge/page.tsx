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
    const scoped = project
      ? await listKnowledge(user.id, {
          project,
          label: label || undefined,
          limit: 300,
          includeSuperseded,
        })
      : universe.filter((r) => {
          if (!includeSuperseded && r.superseded_by) return false
          if (label && !r.labels.includes(label)) return false
          return true
        })

    const rows = entity ? scoped.filter((r) => (r.entities ?? []).includes(entity)) : scoped
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
