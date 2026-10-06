import type { Metadata } from 'next'
import Link from 'next/link'
import { PendingLink } from '@/components/pending-link'
import { LiveUpdates } from '@/components/live-updates'
import { BrandName } from '@/components/brand'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { activityFeed, type ActivityRow } from '@/lib/api/activity-feed'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { EmptyState } from '@/components/empty-state'
import { ActivityList } from './activity-list'
import { ActivityControls } from './activity-controls'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Activity' }

const PAGE = 80

/**
 * Everything that happened, newest first.
 *
 * Every other read in Cairn starts from a thing — a task, a project, a file.
 * This one starts from the day, which is the question a person has after a
 * stretch of agents working: not "what is the state of CAIRN-64" but "what did
 * they all do".
 */
const ActivityPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; actor?: string; kinds?: string; before?: string }>
}) => {
  const { project, actor, kinds, before } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)

  let rows: ActivityRow[] = []
  let failure: string | null = null
  try {
    rows = await activityFeed(user.id, {
      before,
      project: project || undefined,
      actor: actor || undefined,
      kinds: kinds ? kinds.split(',').filter(Boolean) : undefined,
      limit: PAGE,
    })
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Could not load the timeline.'
  }

  const actors = [...new Set(rows.map((r) => r.actor).filter((a): a is string => Boolean(a)))].sort()
  const older = rows.length === PAGE ? rows.at(-1)?.at : null

  const withParam = (key: string, value: string) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ project, actor, kinds })) if (v) p.set(k, v)
    p.set(key, value)
    return `/activity?${p}`
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* the feed is the one page whose whole purpose is what just happened */}
      <LiveUpdates />
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg hidden text-[0.8125rem] sm:block">
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-[0.8125rem]">Activity</span>
        {rows.length > 0 && (
          <span className="text-fg-subtle ml-auto hidden text-[0.75rem] tabular-nums sm:block">
            {rows.length} events
          </span>
        )}
      </header>

      <ActivityControls
        project={project ?? ''}
        actor={actor ?? ''}
        kinds={kinds ?? ''}
        projects={projects.map((p) => ({ key: p.key, title: p.title }))}
        actors={actors}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {failure ? (
          <p className="text-danger px-4 py-8 text-[0.8125rem]">{failure}</p>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here yet." />
        ) : (
          <>
            <ActivityList rows={rows} />
            {older && (
              <div className="px-4 py-6 text-center">
                {/* The same control on /sessions was already a PendingLink and
                    this one was not. It changes only the query string, so
                    loading.tsx never fires, and fetching another page of a feed
                    that unions six stores is not instant — it read as a dead
                    link for as long as it took. */}
                <PendingLink
                  href={withParam('before', older)}
                  className="border-border text-fg-muted hover:text-fg hover:border-border-strong inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.75rem] transition-[color,border-color] duration-[var(--dur-2)] ease-[var(--ease-out)]"
                >
                  Load older
                </PendingLink>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default ActivityPage
