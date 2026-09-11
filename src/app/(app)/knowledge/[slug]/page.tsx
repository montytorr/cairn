import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { entitiesForProject, getKnowledge, listKnowledge, supersededByInfo } from '@/lib/api/knowledge'
import { listEntities } from '@/lib/api/entities'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { KnowledgeDetail } from './knowledge-detail'

export const dynamic = 'force-dynamic'

const KnowledgeDetailPage = async ({ params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const row = await getKnowledge(user.id, slug)
  if (!row) notFound()

  const firstProject = (row.projects ?? [])[0]

  const [projects, entities, others, supersededMap, suggested] = await Promise.all([
    listProjects(user.id),
    listEntities(user.id),
    // Candidates for "supersede": everything but this row and anything
    // already retired, so the picker cannot chain a superseded row to
    // another one.
    listKnowledge(user.id, { limit: 300, includeSuperseded: false }),
    row.superseded_by ? supersededByInfo(user.id, [row.superseded_by]) : Promise.resolve(new Map()),
    // What this could plausibly be scoped to, given the projects it already
    // carries — offered as a hint, not a restriction.
    firstProject ? entitiesForProject(user.id, firstProject) : Promise.resolve([]),
  ])

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <Link
          href="/knowledge"
          className="text-fg-muted hover:text-fg hidden text-[13px] transition-colors sm:block"
        >
          Knowledge
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg min-w-0 truncate text-[13px]">{row.title}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <KnowledgeDetail
          slug={slug}
          row={{
            title: row.title,
            body: row.body,
            labels: row.labels,
            projects: row.projects ?? [],
            entities: row.entities ?? [],
            verified: Boolean(row.verified_at),
            updatedAt: row.updated_at,
            superseded: Boolean(row.superseded_by),
            supersededByRef: row.superseded_by ? (supersededMap.get(row.superseded_by) ?? null) : null,
          }}
          allProjects={projects.map((p) => ({ key: p.key, title: p.title }))}
          allEntities={entities.map((e) => ({ key: e.key, title: e.title }))}
          allLabels={[...new Set(others.flatMap((o) => o.labels))].sort()}
          candidates={others
            .filter((o) => o.slug !== slug)
            .map((o) => ({ slug: o.slug, title: o.title }))}
          suggestedEntities={suggested}
        />
      </div>
    </div>
  )
}

export default KnowledgeDetailPage
