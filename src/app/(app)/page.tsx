import Link from 'next/link'
import { redirect } from 'next/navigation'
import { admin } from '@/lib/supabase/admin'
import { currentUser, listProjects } from '@/lib/data'
import { StatusBadge, TypeBadge } from '@/components/badges'
import type { TaskStatus, TaskType } from '@/schemas/task'

export const dynamic = 'force-dynamic'

type Recent = {
  number: number
  title: string
  type: TaskType
  status: TaskStatus
  updated_at: string
  resolution: string | null
  project: { key: string } | { key: string }[]
}

const Home = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)

  const { data } = await admin()
    .from('tasks')
    .select('number, title, type, status, updated_at, resolution, project:projects!inner(key, owner_user_id)')
    .eq('projects.owner_user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(12)

  const recent = (data ?? []) as unknown as Recent[]
  const keyOf = (r: Recent) => (Array.isArray(r.project) ? r.project[0]?.key : r.project.key) ?? ''

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
      <header className="mb-8">
        <h1 className="text-lg font-semibold tracking-tight">Cairn</h1>
        <p className="text-fg-muted mt-1 text-sm leading-relaxed">
          Shared memory for the agents working here. Before starting a subject, they check
          what has already been done.
        </p>
      </header>

      {projects.length === 0 ? (
        <div className="border-border rounded-md border border-dashed p-6">
          <p className="text-sm">No projects yet.</p>
          <p className="text-fg-muted mt-1.5 text-xs leading-relaxed">
            Create one from an agent or the CLI:
          </p>
          <pre className="bg-surface-raised border-border mt-2 overflow-x-auto rounded border p-2 text-[12px]">
            {`curl -X POST $CAIRN_BASE_URL/api/v1/projects \\
  -H "Authorization: Bearer $CAIRN_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"key":"CAI","title":"Cairn"}'`}
          </pre>
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="text-fg-muted mb-2 text-xs font-medium tracking-wide uppercase">
              Projects
            </h2>
            <ul className="divide-border border-border divide-y overflow-hidden rounded-md border">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.key}`}
                    className="hover:bg-surface-raised flex items-baseline gap-3 px-3 py-2.5 transition-colors"
                  >
                    <code className="text-fg-subtle text-[11px]">{p.key}</code>
                    <span className="text-sm">{p.title}</span>
                    <span className="text-fg-subtle tabular ml-auto text-xs">
                      {p.task_counter} task{p.task_counter === 1 ? '' : 's'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {recent.length > 0 && (
            <section>
              <h2 className="text-fg-muted mb-2 text-xs font-medium tracking-wide uppercase">
                Recently touched
              </h2>
              <ul className="divide-border border-border divide-y overflow-hidden rounded-md border">
                {recent.map((r) => (
                  <li key={`${keyOf(r)}-${r.number}`}>
                    <Link
                      href={`/projects/${keyOf(r)}/tasks/${r.number}`}
                      className="hover:bg-surface-raised flex items-center gap-2.5 px-3 py-2 transition-colors"
                    >
                      <code className="text-fg-subtle w-16 shrink-0 text-[11px]">
                        {keyOf(r)}-{r.number}
                      </code>
                      <TypeBadge type={r.type} compact />
                      <StatusBadge status={r.status} compact />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
                      {r.resolution && (
                        <span className="text-status-done shrink-0 text-[11px]">answered</span>
                      )}
                      <span className="text-fg-subtle tabular shrink-0 text-[11px]">
                        {r.updated_at.slice(5, 10)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default Home
