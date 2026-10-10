import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { handoffIsOpen, type Handoff } from './types'

const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null)

/**
 * Where a handed-off task lives now: the tracker and its ref, linked when the
 * link is a web address. While the hand-off is open the tracker owns the
 * status, and the badge says so; an ended one reads as history.
 */
export const HandoffBadge = ({
  handoff,
  className,
}: {
  handoff: Handoff
  className?: string
}) => {
  const open = handoffIsOpen(handoff)
  const href = safeUrl(handoff.url)
  const label = (
    <>
      <ArrowUpRight size={11} aria-hidden className="shrink-0" />
      <span className="truncate">
        {open ? 'Handed to' : 'Was handed to'} {handoff.tracker}
        <span className="font-mono"> · {handoff.ref}</span>
      </span>
    </>
  )
  const classes = cn(
    'border-border text-fg-muted inline-flex h-[1.25rem] max-w-full min-w-0 items-center gap-1 rounded-full border px-2 text-meta leading-none',
    href && 'hover:text-fg hover:border-border-strong transition-colors',
    className,
  )
  const title = [
    open ? 'The status is owned by the other tracker while this is open.' : 'The hand-off ended.',
    handoff.status ? `Status there: ${handoff.status}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classes} title={title}>
      {label}
    </a>
  ) : (
    <span className={classes} title={title}>
      {label}
    </span>
  )
}
