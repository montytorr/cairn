import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { ThemeToggle } from '@/components/theme-toggle'
import { CommandPalette } from '@/components/command-palette'
import { SignOut } from '@/components/sign-out'
import { ProjectNav } from '@/components/project-nav'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this already; a layout renders data and should not
  // assume the guard ran.
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside
        className={
          'border-border bg-surface-sunken flex shrink-0 flex-col border-b ' +
          'md:sticky md:top-0 md:h-dvh md:w-56 md:border-r md:border-b-0'
        }
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <Link href="/" className="group flex items-baseline gap-1.5">
            {/* The one place the display face appears in the chrome. */}
            <span className="font-display text-[17px] leading-none">Cairn</span>
            <span className="bg-fg-subtle group-hover:bg-accent size-1 rounded-full transition-colors" />
          </Link>
          <ThemeToggle />
        </div>

        <ProjectNav projects={projects.map((p) => ({ key: p.key, title: p.title }))} />

        <div className="border-border text-fg-subtle border-t px-4 py-3 text-[11px]">
          <Link
            href="/settings"
            className="hover:text-fg block truncate transition-colors"
            title={user.email ?? ''}
          >
            {user.email}
          </Link>
          <div className="mt-1.5 flex items-center justify-between">
            <span>
              <kbd className="border-border bg-surface rounded border px-1 font-mono text-[10px]">
                ⌘K
              </kbd>{' '}
              search
            </span>
            <div className="flex gap-2.5">
              <Link href="/settings" className="hover:text-fg transition-colors">
                Settings
              </Link>
              <SignOut />
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
      <CommandPalette projects={projects.map((p) => ({ key: p.key, title: p.title }))} />
    </div>
  )
}

export default AppLayout
