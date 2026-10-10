import { cn } from '@/lib/utils'
import { CATEGORY_LABEL, safeColor, type Stage } from './types'

type StageLike = Pick<Stage, 'color' | 'category' | 'name'>

/**
 * A stage as a small round mark, in the stage's own colour. Shape carries the
 * category and colour carries the stage, so neither says it alone: planned is
 * an empty ring, active a ring with its first half taken, completed a filled
 * disc with a tick, dropped a ring struck through.
 */
export const StageIcon = ({
  stage,
  size = 13,
  className,
}: {
  stage: Pick<Stage, 'color' | 'category'>
  size?: number
  className?: string
}) => {
  const color = safeColor(stage.color)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={cn('shrink-0', className)}
      style={{ color }}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity={stage.category === 'dropped' ? 0.7 : 1} />
      {stage.category === 'active' ? <path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" /> : null}
      {stage.category === 'completed' ? (
        <>
          <circle cx="8" cy="8" r="6" fill="currentColor" />
          <path d="M5.4 8.2l1.8 1.8 3.4-3.6" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : null}
      {stage.category === 'dropped' ? (
        <path d="M5 11l6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

/** The mark and the name, for rows, headings and chips. */
export const StageBadge = ({ stage, className }: { stage: StageLike; className?: string }) => (
  <span
    className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    title={`${stage.name} · ${CATEGORY_LABEL[stage.category].toLowerCase()}`}
  >
    <StageIcon stage={stage} />
    <span className="truncate">{stage.name}</span>
  </span>
)
