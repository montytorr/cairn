'use client'

import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'

/** One width for every board column, the drag overlay included. */
export const COLUMN_WIDTH = 'w-[17rem]'

export const COLUMN_PANEL = 'bg-bg-elevated border-border flex shrink-0 snap-start flex-col rounded-lg border'

export const ColumnCount = ({ count }: { count: number }) => (
  <span className="text-fg-subtle tabular bg-surface ml-auto rounded px-1.5 text-[0.6875rem]">{count}</span>
)

const EmptyCell = ({ over }: { over: boolean }) => (
  <p
    className={cn(
      'text-fg-subtle flex min-h-14 flex-1 items-center justify-center rounded-md border border-dashed text-[0.6875rem] transition-colors',
      over ? 'border-accent text-accent' : 'border-transparent',
    )}
  >
    {over ? 'Drop here' : 'Nothing here'}
  </p>
)

/**
 * The drop target and its scroll box are the same element. dnd-kit measures
 * the visible rect of that node, so a list scrolled halfway still takes a
 * drop anywhere it is on screen, and cards scroll inside it rather than
 * stretching the page. Only a full-height column should contain its
 * overscroll (pass `overscroll-contain`): a capped lane cell has to hand the
 * wheel back so the board scrolls on to the next lane.
 */
export const DropList = ({
  dropId,
  count,
  className,
  children,
}: {
  dropId: string
  count: number
  className?: string
  children: React.ReactNode
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col gap-1.5 overflow-y-auto rounded-md p-1.5 transition-colors',
        isOver && 'bg-accent-subtle',
        className,
      )}
    >
      {count === 0 ? <EmptyCell over={isOver} /> : children}
    </div>
  )
}

export const DragPreview = ({ title }: { title: string }) => (
  <div className={cn('bg-surface border-accent rotate-1 rounded-md border p-2.5 raised-lg', COLUMN_WIDTH)}>
    <p className="text-[0.8125rem] font-medium">{title}</p>
  </div>
)
