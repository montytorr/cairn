import {
  AlertCircle, Bug, Check, CircleDashed, CircleDot, Eye, FileText,
  Lightbulb, Minus, Sparkles, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'

/**
 * Colour is reserved almost entirely for conveying state, and each scale is
 * defined once as an oklch token in globals.css so a dense list of badges
 * reads as one system rather than a pile of swatches.
 */

const STATUS_META: Record<TaskStatus, { label: string; icon: LucideIcon; color: string }> = {
  backlog: { label: 'Backlog', icon: CircleDashed, color: 'text-status-backlog' },
  todo: { label: 'Todo', icon: CircleDot, color: 'text-status-todo' },
  doing: { label: 'Doing', icon: CircleDot, color: 'text-status-doing' },
  'in-review': { label: 'In review', icon: Eye, color: 'text-status-in-review' },
  done: { label: 'Done', icon: Check, color: 'text-status-done' },
  cancelled: { label: 'Cancelled', icon: X, color: 'text-status-cancelled' },
}

const TYPE_META: Record<TaskType, { label: string; icon: LucideIcon }> = {
  feature: { label: 'Feature', icon: Sparkles },
  bug: { label: 'Bug', icon: Bug },
  improvement: { label: 'Improvement', icon: Lightbulb },
  chore: { label: 'Chore', icon: Wrench },
  spike: { label: 'Spike', icon: AlertCircle },
  docs: { label: 'Docs', icon: FileText },
}

const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: 'text-priority-urgent' },
  high: { label: 'High', color: 'text-priority-high' },
  medium: { label: 'Medium', color: 'text-priority-medium' },
  low: { label: 'Low', color: 'text-priority-low' },
}

export const StatusBadge = ({ status, compact }: { status: TaskStatus; compact?: boolean }) => {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', meta.color)} title={meta.label}>
      <Icon size={13} strokeWidth={2.25} aria-hidden />
      {!compact && <span className="text-fg-muted">{meta.label}</span>}
    </span>
  )
}

export const TypeBadge = ({ type, compact }: { type: TaskType; compact?: boolean }) => {
  const meta = TYPE_META[type]
  const Icon = meta.icon
  return (
    <span className="text-fg-subtle inline-flex items-center gap-1.5 text-xs" title={meta.label}>
      <Icon size={13} strokeWidth={2} aria-hidden />
      {!compact && <span>{meta.label}</span>}
    </span>
  )
}

/**
 * Priority renders as bars rather than a word: it is scanned down a column,
 * where a shape reads faster than text and takes less width.
 */
export const PriorityBadge = ({ priority }: { priority: TaskPriority }) => {
  const meta = PRIORITY_META[priority]
  const filled = { urgent: 3, high: 3, medium: 2, low: 1 }[priority]
  if (priority === 'urgent') {
    return (
      <span className={cn('inline-flex items-center', meta.color)} title="Urgent">
        <AlertCircle size={13} strokeWidth={2.5} aria-hidden />
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-end gap-[2px]', meta.color)} title={meta.label}>
      {[3, 5, 7].map((h, i) => (
        <span
          key={h}
          className="w-[3px] rounded-sm bg-current"
          style={{ height: h, opacity: i < filled ? 1 : 0.25 }}
        />
      ))}
    </span>
  )
}

export const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="border-border text-fg-muted rounded-full border px-1.5 py-px text-[11px] leading-4">
    {children}
  </span>
)

/**
 * Distinguishes an agent from the human at a glance. With three agents writing
 * to the same board, "who did this" is the first thing you want from a row.
 */
export const ActorChip = ({ actorId, actorType }: { actorId: string; actorType?: string }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 text-[11px]',
      actorType === 'agent' ? 'text-accent' : 'text-fg-subtle',
    )}
    title={actorType === 'agent' ? `agent: ${actorId}` : 'you'}
  >
    {actorType === 'agent' ? <Minus size={10} className="rotate-90" aria-hidden /> : null}
    {actorType === 'agent' ? actorId : 'you'}
  </span>
)

export const ClaimChip = ({ by, stale }: { by: string; stale: boolean }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px]',
      stale ? 'text-fg-subtle border-border border' : 'bg-accent-subtle text-accent',
    )}
    title={stale ? `${by} holds this but has gone quiet — the lease is stealable` : `held by ${by}`}
  >
    {by}
    {stale ? ' · stale' : ''}
  </span>
)
