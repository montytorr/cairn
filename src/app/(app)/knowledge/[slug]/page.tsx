import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { LiveUpdates } from '@/components/live-updates'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import {
  entitiesForProject,
  getKnowledge,
  knowledgeRevisions,
  listKnowledge,
  sourceTaskRef,
  supersededByInfo,
} from '@/lib/api/knowledge'
import { listEntities } from '@/lib/api/entities'
import { COUNTED, RECALL_WINDOW_DAYS, recallCounts } from '@/lib/api/knowledge-use'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { KnowledgeDetail } from './knowledge-detail'

export const dynamic = 'force-dynamic'

// Deduped against the page's own lookup below (React cache(), same request).
const cachedKnowledge = cache(getKnowledge)

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> => {
  const { slug } = await params
  const user = await currentUser()
  if (!user) return { title: slug }
  const row = await cachedKnowledge(user.id, slug)
  return { title: row ? row.title : slug }
}

const KnowledgeDetailPage = async ({ params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const row = await cachedKnowledge(user.id, slug)
  if (!row) notFound()

  const firstProject = (row.projects ?? [])[0]

  const [projects, entities, others, supersededMap, suggested, learnedOn, history, use] = await Promise.all([
    listProjects(user.id),
    listEntities(user.id),
    // Only for the label suggestions now. The supersede picker used to be fed
    // from here — every current entry, shipped to the browser on every page
    // view and capped at 300 against a corpus of 348 — and now searches the
    // server instead.
    listKnowledge(user.id, { limit: 300, includeSuperseded: false }),
    row.superseded_by ? supersededByInfo(user.id, [row.superseded_by]) : Promise.resolve(new Map()),
    // What this could plausibly be scoped to, given the projects it already
    // carries — offered as a hint, not a restriction.
    firstProject ? entitiesForProject(user.id, firstProject) : Promise.resolve([]),
    // Where this was learned. Stored since knowledge existed, shown nowhere.
    sourceTaskRef(user.id, row.source_task_id),
    // What it said before each correction (CAIRN-266).
    knowledgeRevisions(user.id, slug),
    // How often it is actually handed to anyone (CAIRN-270).
    recallCounts([row.id]),
  ])

  return (
    <div className="flex h-dvh flex-col">
      {/* A fact can be corrected or superseded by an agent while somebody is
          reading it, and reading a claim that has just been withdrawn is the
          failure this store exists to prevent. */}
      <LiveUpdates />
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/knowledge"
          className="text-fg-muted hover:text-fg hidden text-ui transition-colors sm:block"
        >
          Knowledge
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg min-w-0 truncate text-ui">{row.title}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
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
            createdAt: row.created_at,
            author: row.actor_id,
            sourceTask: learnedOn,
          }}
          recall={{
            days: RECALL_WINDOW_DAYS,
            returned: use.get(row.id)?.returned ?? 0,
            read: use.get(row.id)?.read ?? 0,
            lastRecalled: use.get(row.id)?.lastRecalled ?? null,
            counted: COUNTED,
          }}
          revisions={(history?.revisions ?? []).map((r) => ({
            revision: r.revision,
            title: r.title,
            body: r.body,
            change: r.change,
            editedBy: r.edited_by,
            editedAt: r.edited_at,
            reason: r.reason,
          }))}
          allProjects={projects.map((p) => ({ key: p.key, title: p.title }))}
          allEntities={entities.map((e) => ({ key: e.key, title: e.title }))}
          allLabels={[...new Set(others.flatMap((o) => o.labels))].sort()}
          suggestedEntities={suggested}
        />
      </div>
    </div>
  )
}

export default KnowledgeDetailPage
