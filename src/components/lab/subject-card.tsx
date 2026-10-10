'use client'

import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ProjectLabel } from './project-label'
import { TagChip } from './tag-chip'
import { subjectHref, type SubjectSummary } from './types'

/** "2 of 5 done", short, for a card or a row; nothing when there are no todos. */
export const TodoTally = ({
  todos,
  className,
}: {
  todos: SubjectSummary['todos']
  className?: string
}) => {
  const total = todos.open + todos.done
  if (total === 0) return null
  return (
    <span
      className={cn('text-fg-subtle tabular inline-flex shrink-0 items-center gap-1.5 text-meta', className)}
      title={`${todos.open} open, ${todos.done} done`}
    >
      <span aria-hidden className="bg-border-strong relative h-[3px] w-6 overflow-hidden rounded-full">
        <span
          className="bg-status-done absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${(todos.done / total) * 100}%` }}
        />
      </span>
      {todos.done}/{total}
    </span>
  )
}

/**
 * A subject on the board. The title is the card; the ref, project and people
 * are set small beneath it. A conclusion, when there is one, is quoted under
 * the title: it is the most useful sentence the subject has.
 */
export const SubjectCard = ({
  subject,
  dragging,
  className,
}: {
  subject: SubjectSummary
  dragging?: boolean
  className?: string
}) => (
  <div className={cn('surface-card surface-card-interactive group p-2.5', dragging && 'opacity-40', className)}>
    <div className="mb-1.5 flex items-center gap-2">
      <Link
        href={subjectHref(subject.number)}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        className="text-fg-subtle hover:text-accent shrink-0 font-mono text-meta"
      >
        {subject.ref}
      </Link>
      {subject.project ? <ProjectLabel project={subject.project} /> : null}
      {subject.owner ? (
        <span className="ml-auto flex" title={`Owner: ${subject.owner.name}`}>
          <Avatar name={subject.owner.name} size={16} />
        </span>
      ) : null}
    </div>

    <Link
      href={subjectHref(subject.number)}
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      className="text-fg block text-ui leading-snug font-medium text-pretty"
    >
      {subject.title}
    </Link>

    {subject.conclusion ? (
      <p className="text-fg-muted mt-1.5 line-clamp-2 text-meta leading-snug">{subject.conclusion}</p>
    ) : null}

    {subject.tags.length > 0 || subject.todos.open + subject.todos.done > 0 ? (
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {subject.tags.slice(0, 3).map((tag) => (
          <TagChip key={tag.id} tag={tag} />
        ))}
        {subject.tags.length > 3 ? (
          <span className="text-fg-subtle text-meta">+{subject.tags.length - 3}</span>
        ) : null}
        <TodoTally todos={subject.todos} className="ml-auto" />
      </div>
    ) : null}
  </div>
)
