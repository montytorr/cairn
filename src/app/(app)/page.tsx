import Link from 'next/link'
import { redirect } from 'next/navigation'
import { admin } from '@/lib/supabase/admin'
import { currentUser, listProjects } from '@/lib/data'
import { StatusIcon, TypePill } from '@/components/icons'
import type { TaskStatus, TaskType } from '@/schemas/task'

export const dynamic = 'force-dynamic'

type Recent = {
  number: number
  title: string
  type: TaskType
  status: TaskStatus
  updated_at: string
  has_resolution: boolean
  external_ref: string | null
  project: { key: string } | { key: string }[]
}

const Home = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)

  const [{ data: recentRows }, { count: openCount }, { count: totalCount }] = await Promise.all([
    admin()
      .from('tasks')
      .select(
        'number, title, type, status, updated_at, has_resolution, external_ref, project:projects!inner(key, owner_user_id)',
      )
      .eq('projects.owner_user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(10),
    admin()
      .from('tasks')
      .select('id, project:projects!inner(owner_user_id)', { count: 'exact', head: true })
      .eq('projects.owner_user_id', user.id)
      .not('status', 'in', '(done,cancelled)'),
    admin()
      .from('tasks')
      .select('id, project:projects!inner(owner_user_id)', { count: 'exact', head: true })
      .eq('projects.owner_user_id', user.id),
  ])

  const recent = (recentRows ?? []) as unknown as Recent[]
  const keyOf = (r: Recent) => (Array.isArray(r.project) ? r.project[0]?.key : r.project.key) ?? ''

  if (projects.length === 0) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6">
        <h1 className="mb-2 text-[20px] font-semibold tracking-[-0.01em]">Nothing here yet</h1>
        <p className="text-fg-muted mb-5 leading-relaxed">
          A cairn is built one stone at a time. Create the first project from an agent, or
          from the CLI.
        </p>
        <pre className="border-border bg-surface overflow-x-auto rounded-md border p-3 font-mono text-[12px] leading-relaxed">
          {`cairn add "first task" --project CAI --type feature`}
        </pre>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <header className="mb-8">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Cairn</h1>
        <p className="text-fg-muted mt-2 max-w-md leading-relaxed">
          Shared memory for the agents working here. Before starting a subject they check
          what has already been done.
        </p>
        <p className="text-fg-subtle tabular mt-3 text-[11px]">
          {projects.length} projects · {openCount ?? 0} open · {totalCount ?? 0} total
        </p>
      </header>

      {recent.length > 0 && (
        <section>
          <div className="mb-1.5 flex items-baseline gap-2 px-1">
            <h2 className="text-fg-muted text-[11px] font-medium tracking-wide uppercase">
              Recently touched
            </h2>
            <span className="bg-border ml-1 h-px flex-1" />
          </div>
          <ul className="border-border divide-border overflow-hidden rounded-md border divide-y">
            {recent.map((r, i) => (
              <li
                key={`${keyOf(r)}-${r.number}`}
                className="settle"
                style={{ animationDelay: `${i * 18}ms` }}
              >
                <Link
                  href={`/projects/${keyOf(r)}/tasks/${r.number}`}
                  className="flex h-[36px] items-center gap-2.5 px-3 transition-colors duration-100 hover:bg-surface-raised"
                >
                  <StatusIcon status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
                  {r.has_resolution && (
                    <span
                      className="bg-status-done size-1.5 shrink-0 rounded-full"
                      title="has a recorded resolution"
                    />
                  )}
                  <span className="hidden shrink-0 sm:block">
                    <TypePill type={r.type} />
                  </span>
                  <code className="text-fg-subtle hidden shrink-0 text-[10.5px] md:block">
                    {r.external_ref ?? `${keyOf(r)}-${r.number}`}
                  </code>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export default Home
