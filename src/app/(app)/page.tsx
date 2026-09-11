import Link from 'next/link'
import { redirect } from 'next/navigation'
import { admin } from '@/lib/supabase/admin'
import { currentUser, listAllTasks, listProjects } from '@/lib/data'
import { ListView } from './projects/[key]/list-view'
import { LiveUpdates } from '@/components/live-updates'
import { ProjectIcon } from '@/components/icons'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { PendingLink } from '@/components/pending-link'

export const dynamic = 'force-dynamic'

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <span className="text-fg-subtle text-[12px]">
    <span className="text-fg tabular font-medium">{value}</span> {label}
  </span>
)

const Home = async ({ searchParams }: { searchParams: Promise<{ closed?: string }> }) => {
  const { closed } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const includeClosed = closed === '1'
  const [projects, { tasks, closedHidden }, counts] = await Promise.all([
    listProjects(user.id),
    listAllTasks(user.id, { includeClosed }),
    admin()
      .from('tasks')
      .select('id, project:projects!project_id!inner(owner_user_id)', { count: 'exact', head: true })
      .eq('projects.owner_user_id', user.id),
  ])

  const held = tasks.filter((t) => t.claimed_by).length

  if (projects.length === 0) {
    return (
      <div className="mx-auto flex h-dvh max-w-lg flex-col justify-center px-5 sm:px-6">
        <h1 className="mb-2 text-[20px] font-semibold tracking-[-0.01em]">Nothing here yet</h1>
        <p className="text-fg-muted mb-5 text-[13px] leading-relaxed">
          A cairn is built one stone at a time. Create the first project from an agent, or from
          the CLI.
        </p>
        <pre className="border-border bg-surface overflow-x-auto rounded-md border p-3 font-mono text-[12px]">
          {`cairn add "first task" --project CAI --type feature`}
        </pre>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-2 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <span className="text-fg shrink-0 text-[13px] font-medium">All tasks</span>
        <span className="text-fg-subtle hidden text-[13px] sm:block">·</span>
        {/* The counts are the first thing to go on a phone — the list itself
            says more than a tally of it. */}
        <span className="hidden items-center gap-2 sm:flex">
          <Stat label="open" value={tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length} />
          <Stat label="total" value={counts.count ?? 0} />
          {held > 0 ? <Stat label="held by an agent" value={held} /> : null}
        </span>

        <PendingLink
          href={includeClosed ? '/' : '/?closed=1'}
          className="text-fg-subtle hover:text-fg ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] transition-colors"
        >
          {includeClosed ? 'Hide closed' : `Show ${closedHidden} closed`}
        </PendingLink>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Cross-project, so each row carries its project. Same component as
            the per-project list — one list implementation, not two. */}
        <ListView
          tasks={tasks}
          projectKey=""
          showProject
          projects={projects.map((p) => ({ key: p.key, title: p.title }))}
        />

        <section className="border-border mt-6 border-t px-4 py-4">
          <h2 className="text-fg-muted mb-2 text-[11px] font-medium">Projects</h2>
          <ul className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.key}`}
                  className="border-border text-fg-muted hover:bg-surface-hover hover:text-fg flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors"
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
