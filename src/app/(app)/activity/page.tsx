import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { activityFeed, type ActivityRow } from '@/lib/api/activity-feed'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { ActivityList } from './activity-list'
import { ActivityControls } from './activity-controls'

export const dynamic = 'force-dynamic'

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
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg hidden text-[13px] sm:block">
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-[13px]">Activity</span>
        {rows.length > 0 && (
          <span className="text-fg-subtle ml-auto hidden text-[12px] sm:block">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure ? (
          <p className="text-danger px-4 py-8 text-[13px]">{failure}</p>
        ) : rows.length === 0 ? (
          <p className="text-fg-subtle px-4 py-12 text-center text-[13px]">
            Nothing here yet.
          </p>
        ) : (
          <>
            <ActivityList rows={rows} />
            {older && (
              <div className="px-4 py-6 text-center">
                <Link
                  href={withParam('before', older)}
                  className="text-fg-subtle hover:text-fg text-[12px] transition-colors"
                >
                  Load older
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default ActivityPage
