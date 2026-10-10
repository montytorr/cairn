import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { listFormerKeys } from '@/lib/api/project-keys'
import { knownSlugs } from '@/lib/api/knowledge-graph'
import { listPeople } from '@/lib/api/people'
import { CommandPalette } from '@/components/command-palette'
import { AppSidebar } from '@/components/app-sidebar'
import { TaskCreationProvider } from '@/components/task-creation'
import { Shortcuts } from '@/components/shortcuts'
import { ProjectKeysProvider } from '@/components/project-keys'
import { PeopleProvider } from '@/components/people-context'
import { KnowledgeSlugsProvider } from '@/components/knowledge-slugs'
import { MobileNavProvider } from '@/components/mobile-nav-context'
import { ToastHost } from '@/components/toast'
import { HealthBanner } from '@/components/health-banner'
import { LiveStatusIndicator, LiveStatusProvider } from '@/components/live-status'
import { loginRedirectTarget } from '@/lib/auth/login-redirect-server'
import { LabProvider } from '@/components/lab/lab-context'
import { isLabEnabled } from './lab/data'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this; a layout renders data and should not assume
  // the guard ran.
  if (!user) redirect(await loginRedirectTarget())

  const [projects, formerKeys, slugs, people, labEnabled] = await Promise.all([
    listProjects(user.id),
    listFormerKeys(user.id),
    // Every slug there is, so `[[a-reference]]` to an entry nobody wrote can
    // be drawn as the loose end it is. One column, and it has to be ALL of
    // them: a partial list would mark real entries as missing.
    knownSlugs().catch(() => null),
    // Fetched once for every assignee picker in the app, rather than each one
    // loading its own copy of the same short list.
    listPeople(),
    // Read here, on the server, so the sidebar entry and the `LAB-12` linkifier
    // are right on first paint. Off, nothing lab-shaped is drawn anywhere.
    isLabEnabled(),
  ])
  const email = user.email ?? 'you'
  const projectList = projects.map((p) => ({ key: p.key, title: p.title }))

  // Retired keys linkify too. A bare `ACME-42` in a task body or an agent's
  // note is matched by pattern against this list, so after a rename it still
  // looked like a ref, was still a link, and led nowhere — the memory store
  // breaking its own cross-references.
  const refKeys = [...projectList.map((p) => p.key), ...formerKeys.map((f) => f.key)]

  return (
    <ToastHost>
      <LiveStatusProvider>
      <ProjectKeysProvider keys={refKeys}>
        <PeopleProvider people={people} currentUserId={user.id}>
        <KnowledgeSlugsProvider slugs={slugs}>
        <TaskCreationProvider projects={projectList}>
        <LabProvider enabled={labEnabled}>
          <MobileNavProvider email={email} role={user.role} projects={projectList}>
            <div className="bg-bg flex h-dvh">
              <aside className="app-sidebar hidden w-[13.75rem] shrink-0 flex-col md:flex">
                <AppSidebar email={email} role={user.role} projects={projectList} />
              </aside>

              {/* Beside the content, not above the sidebar: the shell is a flex
                row, and a banner spanning it would push the whole app down. */}
            <div className="app-canvas flex min-w-0 flex-1 flex-col">
              <HealthBanner userId={user.id} />
              <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
            </div>
              <CommandPalette projects={projectList} />
              <Shortcuts />
              {/* Fixed to the viewport, outside the scroll containers each
                  page owns, so it stays put wherever the reader is. */}
              <LiveStatusIndicator />
            </div>
          </MobileNavProvider>
        </LabProvider>
        </TaskCreationProvider>
        </KnowledgeSlugsProvider>
        </PeopleProvider>
      </ProjectKeysProvider>
      </LiveStatusProvider>
    </ToastHost>
  )
}

export default AppLayout
