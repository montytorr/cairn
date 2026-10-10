import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { ProjectRef } from './types'

/** A subject's Cairn project: the project's own mark and its key. */
export const ProjectLabel = ({
  project,
  className,
}: {
  project: Pick<ProjectRef, 'key' | 'title'>
  className?: string
}) => (
  <span
    className={cn('text-fg-muted inline-flex min-w-0 items-center gap-1.5 text-meta', className)}
    title={project.title}
  >
    <ProjectIcon size={12} projectKey={project.key} />
    <span className="truncate font-mono">{project.key}</span>
  </span>
)
