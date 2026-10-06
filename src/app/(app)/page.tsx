import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { admin } from '@/lib/db/client'
import { currentUser, listAllTasks, listProjects } from '@/lib/data'
import { ListView } from './projects/[key]/list-view'
import { LiveUpdates } from '@/components/live-updates'
import { ProjectIcon } from '@/components/icons'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { ClosedToggle } from '@/components/closed-toggle'
import { EmptyState } from '@/components/empty-state'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Tasks' }

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <span className="text-fg-subtle text-[0.75rem]">
    <span className="text-fg tabular font-medium">{value}</span> {label}
  </span>
)

const Home = async ({ searchParams }: { searchParams: Promise<{ closed?: string; assignee?: string }> }) => {
  const { closed, assignee } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const includeClosed = closed === '1'
  const [projects, { tasks, closedHidden, recentlyClosed }, counts] = await Promise.all([
    listProjects(user.id),
    listAllTasks(user.id, { includeClosed }),
    admin()
      .from('tasks')
      .select('id', { count: 'exact', head: true }),
  ])

  const held = tasks.filter((t) => t.claimed_by).length

  if (projects.length === 0) {
    return (
      <div className="mx-auto flex h-dvh max-w-lg flex-col justify-center px-5 sm:px-6">
        <EmptyState
          as="h1"
          title="Nothing here yet"
          hint="A cairn is built one stone at a time. Create the first project from an agent, or from the CLI."
          action={
            <pre className="surface-card max-w-full overflow-x-auto px-3 py-2.5 text-left font-mono text-[0.75rem]">
              {`cairn add "first task" --project CAI --type feature`}
            </pre>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg shrink-0 text-[0.8125rem] font-medium">All tasks</span>
        <span className="text-fg-subtle hidden text-[0.8125rem] sm:block">·</span>
        {/* The counts are the first thing to go on a phone — the list itself
            says more than a tally of it. */}
        <span className="hidden items-center gap-2 sm:flex">
          <Stat label="open" value={tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length} />
          <Stat label="total" value={counts.count ?? 0} />
          {held > 0 ? <Stat label="held by an agent" value={held} /> : null}
        </span>

        <ClosedToggle
          path="/"
          includeClosed={includeClosed}
          hidden={closedHidden}
          className="text-fg-subtle hover:text-fg ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.75rem] transition-colors"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Cross-project, so each row carries its project. Same component as
            the per-project list — one list implementation, not two. */}
        <ListView
          tasks={tasks}
          recentlyClosed={recentlyClosed}
          projectKey=""
          showProject
          projects={projects.map((p) => ({ key: p.key, title: p.title }))}
          initialAssignee={assignee}
        />

        <section className="border-border mt-6 border-t px-4 py-4">
          <h2 className="text-fg-muted mb-2 text-[0.6875rem] font-medium">Projects</h2>
          <ul className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.key}`}
                  className="border-border text-fg-muted hover:bg-surface-hover hover:text-fg hover:border-border-strong flex h-[1.625rem] items-center gap-1.5 rounded-md border px-2 text-[0.75rem] transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]"
                >
                  <ProjectIcon size={12} projectKey={p.key} />
                  {p.title}
                  <span className="text-fg-subtle tabular">{p.task_counter}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <LiveUpdates />
    </div>
  )
}

export default Home
