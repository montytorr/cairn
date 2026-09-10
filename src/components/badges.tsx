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
 * Priority renders as a shape in the left margin, never a word. It is scanned
 * vertically down a column of hundreds of rows, and at that job a silhouette
 * beats text: it reads in peripheral vision and costs 12px instead of 60.
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
    <span
      className={cn('inline-flex items-end gap-[2px]', meta.color)}
      title={`${meta.label} priority`}
      aria-label={`${meta.label} priority`}
    >
      {[4, 6, 8].map((h, i) => (
        <span
          key={h}
          className="w-[2.5px] rounded-[1px] bg-current transition-opacity"
          style={{ height: h, opacity: i < filled ? 1 : 0.18 }}
        />
      ))}
    </span>
  )
}

export const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="bg-surface-raised text-fg-muted rounded px-1.5 py-px text-[10.5px] leading-4">
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
      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10.5px] leading-4',
      stale ? 'text-fg-subtle bg-surface-raised' : 'bg-accent-subtle text-accent',
    )}
    title={stale ? `${by} holds this but has gone quiet — the lease is stealable` : `held by ${by}`}
  >
    {/* A live claim pulses; a stale one does not. The difference should be
        visible without reading the label. */}
    {!stale && <span className="bg-accent size-1 animate-pulse rounded-full" />}
    {by}
    {stale ? ' · stale' : ''}
  </span>
)
