import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { safeColor, type Tag } from './types'

/**
 * A curated tag. The colour sits on a dot and tints the rim; the word stays
 * ink, because an admin's colour is not measured against either ground.
 */
export const TagChip = ({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<Tag, 'name' | 'color'>
  onRemove?: () => void
  className?: string
}) => {
  const color = safeColor(tag.color)
  return (
    <span
      className={cn(
        'text-fg-muted inline-flex h-[1.25rem] max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 text-meta leading-none',
        className,
      )}
      style={{ borderColor: `color-mix(in oklab, ${color} 35%, var(--border))` }}
    >
      <span aria-hidden className="size-[0.375rem] shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${tag.name}`}
          className="text-fg-subtle hover:text-fg -mr-1 grid size-4 place-items-center rounded-full transition-colors"
        >
          <X size={10} aria-hidden />
        </button>
      ) : null}
    </span>
  )
}
