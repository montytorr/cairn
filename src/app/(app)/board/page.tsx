import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { listBoardTasks } from '@/lib/board-data'
import { CrossProjectBoard } from './cross-project-board'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { ClosedToggle } from '@/components/closed-toggle'
import { LiveUpdates } from '@/components/live-updates'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Board' }

const BoardPage = async ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) => {
  const params = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const includeClosed = params.closed === '1'
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString()
  const { tasks, projects, closedHidden } = await listBoardTasks(user.id, { includeClosed })

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg shrink-0 text-[0.8125rem] font-medium">Board</span>
        <span className="text-fg-subtle hidden text-[0.8125rem] sm:block">·</span>
        <span className="text-fg-subtle hidden text-[0.8125rem] sm:block">
          {tasks.length} across {projects.length} projects
        </span>

        <ClosedToggle
          path="/board"
          includeClosed={includeClosed}
          hidden={closedHidden}
          className="text-fg-subtle hover:text-fg ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.75rem] transition-colors"
        />
      </header>

      {/* page-scroll-guard: fills the viewport on purpose. The board scrolls
          inside CrossProjectBoard, per column and per lane cell, so the
          toolbar and column headings never scroll away. */}
      <div className="min-h-0 flex-1">
        <CrossProjectBoard tasks={tasks} projects={projects} initialQuery={query} />
      </div>
      <LiveUpdates />
    </div>
  )
}

export default BoardPage
