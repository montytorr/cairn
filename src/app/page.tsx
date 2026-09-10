import { admin } from '@/lib/supabase/admin'
import { serverClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const Home = async () => {
  const supabase = await serverClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: projects } = await admin()
    .from('projects')
    .select('id, key, title, status, task_counter')
    .eq('owner_user_id', user!.id)
    .order('position')

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Cairn</h1>
        <p className="text-fg-muted mt-1 text-sm">
          Signed in as {user?.email}. The board, list and task detail views land in the UI phase —
          the API and CLI are usable now.
        </p>
      </header>

      <section>
        <h2 className="text-fg-muted mb-3 text-xs font-medium tracking-wide uppercase">
          Projects
        </h2>
        {projects && projects.length > 0 ? (
          <ul className="divide-border divide-y">
            {projects.map((p) => (
              <li key={p.id} className="flex items-baseline gap-3 py-3">
                <code className="text-fg-subtle text-xs">{p.key}</code>
                <span className="text-sm">{p.title}</span>
                <span className="text-fg-subtle tabular ml-auto text-xs">
                  {p.task_counter} task{p.task_counter === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg-subtle text-sm">
            No projects yet. Create one with <code className="text-xs">cairn project add</code>.
          </p>
        )}
      </section>
    </main>
  )
}

export default Home
