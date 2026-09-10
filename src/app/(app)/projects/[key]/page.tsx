import { notFound, redirect } from 'next/navigation'
import { currentUser, getProject, listTasks } from '@/lib/data'
import { MarkdownView } from '@/components/markdown'
import { ViewSwitch } from './view-switch'

export const dynamic = 'force-dynamic'

const ProjectPage = async ({ params }: { params: Promise<{ key: string }> }) => {
  const { key } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const project = await getProject(user.id, key)
  if (!project) notFound()

  const tasks = await listTasks(project.id)
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length
  const answered = tasks.filter((t) => t.resolution).length

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8">
      <header className="mb-6">
        <div className="flex items-baseline gap-2.5">
          <code className="text-fg-subtle text-xs">{project.key}</code>
          <h1 className="text-lg font-semibold tracking-tight">{project.title}</h1>
          <span className="text-fg-subtle tabular ml-auto text-xs">
            {open} open · {answered} answered · {tasks.length} total
          </span>
        </div>
        {project.description ? (
          <div className="mt-2 max-w-2xl">
            <MarkdownView>{project.description}</MarkdownView>
          </div>
        ) : null}
      </header>

      <ViewSwitch tasks={tasks} projectKey={project.key} />
    </div>
  )
}

export default ProjectPage
