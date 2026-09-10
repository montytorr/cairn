import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { ThemeToggle } from '@/components/theme-toggle'
import { CommandPalette } from '@/components/command-palette'
import { SignOut } from '@/components/sign-out'
import { ProjectNav } from '@/components/project-nav'
import { Avatar } from '@/components/icons'
import { TaskCreationProvider } from '@/components/task-creation'
import { Shortcuts } from '@/components/shortcuts'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this; a layout renders data and should not assume
  // the guard ran.
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)
  const email = user.email ?? 'you'

  const projectList = projects.map((p) => ({ key: p.key, title: p.title }))

  return (
    <TaskCreationProvider projects={projectList}>
    <div className="bg-bg flex h-dvh">
      <aside className="border-border bg-bg-elevated hidden w-[220px] shrink-0 flex-col border-r md:flex">
        <div className="flex h-[44px] shrink-0 items-center gap-2 px-3">
          <Avatar name={email} size={20} />
          <Link href="/" className="text-fg truncate text-[13px] font-medium">
            Cairn
          </Link>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>

        <ProjectNav projects={projectList} />

        <div className="border-border text-fg-subtle flex items-center gap-2 border-t px-3 py-2 text-[11px]">
          <span className="truncate" title={email}>
            {email}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Link href="/settings" className="hover:text-fg transition-colors">
              Settings
            </Link>
            <SignOut />
          </span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      <CommandPalette projects={projectList} />
      <Shortcuts />
    </div>
    </TaskCreationProvider>
  )
}

export default AppLayout
