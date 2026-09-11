import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { listSessionAgents, listSessions, projectKeysById } from '@/lib/api/sessions'
import { groupByDay } from '@/lib/session-grouping'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { PendingLink } from '@/components/pending-link'
import { SessionControls } from './session-controls'
import { SessionTimeline, type SessionItem } from './session-list'

export const dynamic = 'force-dynamic'

// ~5,000 rows exist; a page holds a fixed slice and the rest are one cursor
// link away, never all loaded at once.
const PAGE_SIZE = 40

const SessionsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; agent?: string; before?: string }>
}) => {
  const { project = '', agent = '', before } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const [projects, agents, rows] = await Promise.all([
    listProjects(user.id),
    listSessionAgents(user.id),
    listSessions(user.id, {
      project: project || undefined,
      agent: agent || undefined,
      before: before || undefined,
      limit: PAGE_SIZE,
    }),
  ])

  const projectKeys = await projectKeysById(
    user.id,
    rows.map((r) => r.project_id).filter((id): id is string => Boolean(id)),
  )

  const items: SessionItem[] = rows.map((r) => ({
    id: r.id,
    endedAt: r.ended_at,
    agent: r.agent_id,
    platform: r.platform_source,
    project: r.project_id ? (projectKeys.get(r.project_id) ?? null) : null,
    request: r.request,
    learned: r.learned,
    completed: r.completed,
    nextSteps: r.next_steps,
    files: r.files ?? [],
    taskRefs: r.task_refs ?? [],
  }))

  const groups = groupByDay(items)
  const oldest = rows.at(-1)?.ended_at
  const hasMore = rows.length === PAGE_SIZE

  const nextHref = (() => {
    if (!hasMore || !oldest) return null
    const params = new URLSearchParams()
    if (project) params.set('project', project)
    if (agent) params.set('agent', agent)
    params.set('before', oldest)
    return `/sessions?${params.toString()}`
  })()

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
        <span className="text-fg text-[13px]">Sessions</span>
        {before && (
          <Link
            href={(() => {
              const params = new URLSearchParams()
              if (project) params.set('project', project)
              if (agent) params.set('agent', agent)
              const qs = params.toString()
              return qs ? `/sessions?${qs}` : '/sessions'
            })()}
            className="text-fg-subtle hover:text-fg ml-2 text-[12px] transition-colors"
          >
            back to newest
          </Link>
        )}
      </header>

      <SessionControls
        project={project}
        agent={agent}
        projects={projects.map((p) => ({ key: p.key, title: p.title }))}
        agents={agents}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-fg-subtle px-4 py-12 text-center text-[13px]">
            No sessions recorded {project || agent ? 'for these filters' : 'yet'}.
          </p>
        ) : (
          <>
            <SessionTimeline groups={groups} />
            {nextHref && (
              <div className="flex justify-center py-4">
                <PendingLink
                  href={nextHref}
                  className="border-border text-fg-muted hover:bg-surface-hover hover:text-fg rounded-md border px-3 py-1.5 text-[12px] transition-colors"
                >
                  Load older sessions
                </PendingLink>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default SessionsPage
