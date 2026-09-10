import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, getProject, listTasks } from '@/lib/data'
import { ProjectIcon } from '@/components/icons'
import { ViewSwitch } from './view-switch'
import { LiveUpdates } from '@/components/live-updates'
import { ProjectMenu } from './project-menu'

export const dynamic = 'force-dynamic'

const ProjectPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  searchParams: Promise<{ closed?: string }>
}) => {
  const { key } = await params
  const { closed } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const project = await getProject(user.id, key)
  if (!project) notFound()

  const includeClosed = closed === '1'
  const { tasks, closedHidden } = await listTasks(project.id, { includeClosed })

  return (
    <div className="flex h-dvh flex-col">
      {/* Breadcrumb bar — fixed height, so the list below always starts in
          the same place regardless of project name length. */}
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-4">
        <Link href="/" className="text-fg-muted hover:text-fg text-[13px] transition-colors">
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-fg-muted flex items-center gap-1.5 text-[13px]">
          <ProjectIcon size={13} />
          {project.title}
        </span>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-fg text-[13px]">Tasks</span>

        <div className="ml-auto flex items-center gap-3">
          {closedHidden > 0 || includeClosed ? (
            <Link
              href={includeClosed ? `/projects/${project.key}` : `/projects/${project.key}?closed=1`}
              className="text-fg-subtle hover:text-fg text-[12px] transition-colors"
            >
              {includeClosed ? 'Hide closed' : `Show ${closedHidden} closed`}
            </Link>
          ) : null}
          <ProjectMenu
            projectKey={project.key}
            title={project.title}
            taskCount={tasks.length + closedHidden}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ViewSwitch tasks={tasks} projectKey={project.key} />
      </div>
      <LiveUpdates projectKey={project.key} />
    </div>
  )
}

export default ProjectPage
