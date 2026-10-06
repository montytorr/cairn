'use client'

import Link from 'next/link'
import { CornerDownRight, Hourglass, ListTree } from 'lucide-react'
import type { Hierarchy } from '@/lib/task-hierarchy'
import { cn } from '@/lib/utils'

const href = (ref: string) => {
  const at = ref.lastIndexOf('-')
  return `/projects/${ref.slice(0, at)}/tasks/${ref.slice(at + 1)}`
}

const CHIP = 'pointer-events-auto relative z-10 inline-flex shrink-0 items-center gap-1 text-meta tabular'

/**
 * Where a task sits among others, on a row or a card (CAIRN-341): whose child
 * it is, how far its own children have got, and what it is still waiting on.
 * Each is a link to that task; the row underneath stays a link to this one.
 */
export const TaskRelations = ({
  task,
  showParent = true,
}: {
  task: Partial<Hierarchy>
  /** Off for a child drawn directly under its parent, where it would only repeat the indent. */
  showParent?: boolean
}) => {
  const waiting = task.waiting_on ?? []
  const children = task.children
  if (!(showParent && task.parent_ref) && !children && waiting.length === 0) return null

  return (
    <>
      {waiting.length > 0 && waiting[0] ? (
        <Link
          href={href(waiting[0])}
          title={`Waiting on ${waiting.join(', ')} — not done yet`}
          className={cn(CHIP, 'text-fg-muted hover:text-fg')}
        >
          <Hourglass size={11} className="text-status-doing" aria-hidden />
          <span className="hidden sm:inline">waiting on</span> {waiting[0]}
          {waiting.length > 1 ? <span className="text-fg-subtle">+{waiting.length - 1}</span> : null}
        </Link>
      ) : null}

      {children ? (
        <span
          title={`${children.closed} of ${children.total} sub-task${children.total === 1 ? '' : 's'} closed`}
          className={cn(CHIP, children.closed === children.total ? 'text-status-done' : 'text-fg-subtle')}
        >
          <ListTree size={11} aria-hidden />
          {children.closed}/{children.total}
        </span>
      ) : null}

      {showParent && task.parent_ref ? (
        <Link
          href={href(task.parent_ref)}
          title={`Sub-task of ${task.parent_ref}`}
          className={cn(CHIP, 'text-fg-subtle hover:text-fg')}
        >
          <CornerDownRight size={11} aria-hidden />
          {task.parent_ref}
        </Link>
      ) : null}
    </>
  )
}
