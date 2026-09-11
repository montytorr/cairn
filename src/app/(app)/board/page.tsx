import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { listBoardTasks } from '@/lib/board-data'
import { CrossProjectBoard } from './cross-project-board'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { PendingLink } from '@/components/pending-link'
import { LiveUpdates } from '@/components/live-updates'

export const dynamic = 'force-dynamic'

/**
 * Preserves every other query param (groupBy, swimlane, the filters) when
 * flipping `closed` — that one alone changes what the server loads, so it is
 * the one part of the view still driven by a real navigation rather than
 * client-side history.replaceState.
 */
const closedToggleHref = (params: Record<string, string | undefined>, includeClosed: boolean) => {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === 'closed' || value === undefined) continue
    next.set(key, value)
  }
  if (!includeClosed) next.set('closed', '1')
  const qs = next.toString()
  return qs ? `/board?${qs}` : '/board'
}

const BoardPage = async ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) => {
  const params = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const includeClosed = params.closed === '1'
  const { tasks, projects, closedHidden } = await listBoardTasks(user.id, { includeClosed })

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-2 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <span className="text-fg shrink-0 text-[13px] font-medium">Board</span>
        <span className="text-fg-subtle hidden text-[13px] sm:block">·</span>
        <span className="text-fg-subtle hidden text-[13px] sm:block">
          {tasks.length} across {projects.length} projects
        </span>

        <PendingLink
          href={closedToggleHref(params, includeClosed)}
          className="text-fg-subtle hover:text-fg ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] transition-colors"
        >
          {includeClosed ? 'Hide closed' : `Show ${closedHidden} closed`}
        </PendingLink>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <CrossProjectBoard tasks={tasks} projects={projects} />
      </div>
      <LiveUpdates />
    </div>
  )
}

export default BoardPage
