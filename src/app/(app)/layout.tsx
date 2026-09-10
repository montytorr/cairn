import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { ThemeToggle } from '@/components/theme-toggle'
import { CommandPalette } from '@/components/command-palette'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware already enforces this; belt and braces, since a layout renders
  // data and should not assume the guard ran.
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-border bg-surface flex shrink-0 flex-col gap-6 border-b p-4 md:h-dvh md:w-56 md:border-r md:border-b-0">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Cairn
          </Link>
          <ThemeToggle />
        </div>

        <nav className="flex-1">
          <p className="text-fg-subtle mb-2 text-[11px] font-medium tracking-wide uppercase">
            Projects
          </p>
          <ul className="flex flex-col gap-px">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.key}`}
                  className="hover:bg-surface-raised flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                >
                  <code className="text-fg-subtle text-[11px]">{p.key}</code>
                  <span className="truncate">{p.title}</span>
                </Link>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="text-fg-subtle px-2 py-1.5 text-xs leading-relaxed">
                None yet. Create one with{' '}
                <code className="text-[11px]">cairn project add</code>.
              </li>
            )}
          </ul>
        </nav>

        <div className="text-fg-subtle text-[11px] leading-relaxed">
          <p className="truncate" title={user.email ?? ''}>
            {user.email}
          </p>
          <p className="mt-1">
            <kbd className="border-border rounded border px-1">⌘K</kbd> to search
          </p>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
      <CommandPalette projects={projects.map((p) => ({ key: p.key, title: p.title }))} />
    </div>
  )
}

export default AppLayout
