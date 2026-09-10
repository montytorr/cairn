import { notFound, redirect } from 'next/navigation'
import { currentUser, getProject, listTasks } from '@/lib/data'
import { MarkdownView } from '@/components/markdown'
import { ViewSwitch } from './view-switch'

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
  const { tasks, total, closedHidden } = await listTasks(project.id, { includeClosed })

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <code className="text-fg-subtle text-[11px]">{project.key}</code>
          <h1 className="font-display text-[22px] leading-none">{project.title}</h1>
          <span className="text-fg-subtle tabular ml-auto text-xs">
            {tasks.length} shown · {total} total
          </span>
        </div>
        {project.description ? (
          <div className="mt-2 max-w-2xl">
            <MarkdownView>{project.description}</MarkdownView>
          </div>
        ) : null}
      </header>

      <ViewSwitch
        tasks={tasks}
        projectKey={project.key}
        closedHidden={closedHidden}
        includeClosed={includeClosed}
      />
    </div>
  )
}

export default ProjectPage
