import Link from 'next/link'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import {
  currentUser, getProject, listFormerKeyRecords, listProjects, listTasks,
} from '@/lib/data'
import { projectRedirectNotice, renameLine, renamesOf } from '@/lib/project-rename'
import { RedirectNotice } from '@/components/redirect-notice'
import { entitiesForProject } from '@/lib/api/knowledge'
import { ProjectIcon } from '@/components/icons'
import { ViewSwitch } from './view-switch'
import { parseProjectView, viewCookieName } from '@/lib/project-view'
import { LiveUpdates } from '@/components/live-updates'
import { ProjectMenu } from './project-menu'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { PendingLink } from '@/components/pending-link'

export const dynamic = 'force-dynamic'

const ProjectPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  searchParams: Promise<{ closed?: string; from?: string }>
}) => {
  const { key } = await params
  const { closed, from } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const [project, formerKeys] = await Promise.all([
    getProject(user.id, key),
    listFormerKeyRecords(),
  ])

  // A retired key is an address somebody still has — in a bookmark, a note, a
  // message from before the rename. It was a 404. Send it on, and say so.
  if (!project) {
    const retired = formerKeys.find((row) => row.key === key.toUpperCase() && row.current)
    if (!retired) notFound()
    const query = new URLSearchParams({ from: retired.key })
    if (closed === '1') query.set('closed', '1')
    redirect(`/projects/${retired.current}?${query}`)
  }

  const includeClosed = closed === '1'
  const [{ tasks, closedHidden, recentlyClosed }, entities, allProjects] = await Promise.all([
    listTasks(project.id, { includeClosed }),
    entitiesForProject(user.id, project.key),
    listProjects(user.id, { includeArchived: true }),
  ])

  const renames = renamesOf(
    formerKeys.filter((row) => row.project_id === project.id),
    project.key,
  )
  const arrivedFrom = projectRedirectNotice(from, renames)
  const initialView = parseProjectView((await cookies()).get(viewCookieName(project.key))?.value)

  return (
    <div className="flex h-dvh flex-col">
      {/* Breadcrumb bar — fixed height, so the list below always starts in
          the same place regardless of project name length. */}
      <header className="border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        {/* The leading crumbs are the first thing to go on a phone: the project
            name is already the page title, and the sidebar is a tap away. */}
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[0.8125rem] transition-colors sm:block"
        >
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg-muted flex min-w-0 items-center gap-1.5 text-[0.8125rem]">
          <ProjectIcon size={13} projectKey={project.key} />
          <span className="truncate">{project.title}</span>
        </span>
        {renames.length > 0 && (
          <span
            className="text-fg-subtle shrink-0 text-[0.6875rem]"
            title={renames.map((r) => renameLine(r)).join('\n')}
          >
            formerly {renames.map((r) => r.from).join(', ')}
          </span>
        )}
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg hidden text-[0.8125rem] sm:block">Tasks</span>
        {/* Which groupings this project belongs to, so "why am I seeing this
            fact here" has an answer where the work happens rather than only in
            settings. Hidden on a phone; the crumbs go first there too. */}
        {entities.length > 0 && (
          <span className="text-fg-subtle ml-1 hidden items-center gap-1 text-[0.6875rem] lg:flex">
            {entities.map((key) => (
              <Link
                key={key}
                href={`/knowledge?entity=${key}`}
                className="border-border hover:text-fg rounded border px-1.5 py-px font-mono transition-colors"
              >
                {key}
              </Link>
            ))}
          </span>
        )}
        {project.status === 'archived' && (
          <span className="border-border text-fg-subtle ml-1 rounded border px-1.5 py-px text-[0.625rem] uppercase tracking-wide">
            Archived
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2 md:gap-3">
          {closedHidden > 0 || includeClosed ? (
            <PendingLink
              href={includeClosed ? `/projects/${project.key}` : `/projects/${project.key}?closed=1`}
              className="text-fg-subtle hover:text-fg flex items-center gap-1.5 whitespace-nowrap text-[0.75rem] transition-colors"
            >
              {includeClosed ? 'Hide closed' : `Show ${closedHidden} closed`}
            </PendingLink>
          ) : null}
          <ProjectMenu
            projectId={project.id}
            projectKey={project.key}
            title={project.title}
            taskCount={tasks.length + closedHidden}
            archived={project.status === 'archived'}
            liveKeys={allProjects.map((p) => p.key)}
            retired={formerKeys}
          />
        </div>
      </header>

      <RedirectNotice message={arrivedFrom} className="mx-4 mt-3 shrink-0" />

      {/* page-scroll-guard: fills the viewport on purpose. ViewSwitch owns the
          scrolling: the list scrolls as one, the board per column. */}
      <div className="min-h-0 flex-1">
        <ViewSwitch
          tasks={tasks}
          recentlyClosed={recentlyClosed}
          projectKey={project.key}
          initialView={initialView}
        />
      </div>
      <LiveUpdates projectKey={project.key} />
    </div>
  )
}

export default ProjectPage
