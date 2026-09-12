import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { CommandPalette } from '@/components/command-palette'
import { AppSidebar } from '@/components/app-sidebar'
import { TaskCreationProvider } from '@/components/task-creation'
import { Shortcuts } from '@/components/shortcuts'
import { ProjectKeysProvider } from '@/components/project-keys'
import { MobileNavProvider } from '@/components/mobile-nav-context'
import { ToastHost } from '@/components/toast'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this; a layout renders data and should not assume
  // the guard ran.
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)
  const email = user.email ?? 'you'
  const projectList = projects.map((p) => ({ key: p.key, title: p.title }))

  return (
    <ToastHost>
      <ProjectKeysProvider keys={projectList.map((p) => p.key)}>
        <TaskCreationProvider projects={projectList}>
          <MobileNavProvider email={email} projects={projectList}>
            <div className="bg-bg flex h-dvh">
              <aside className="border-border bg-bg-elevated hidden w-[220px] shrink-0 flex-col border-r md:flex">
                <AppSidebar email={email} projects={projectList} />
              </aside>

              <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
              <CommandPalette projects={projectList} />
              <Shortcuts />
            </div>
          </MobileNavProvider>
        </TaskCreationProvider>
      </ProjectKeysProvider>
    </ToastHost>
  )
}

export default AppLayout
