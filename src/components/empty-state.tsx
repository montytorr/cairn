import { cn } from '@/lib/utils'

/**
 * One empty state for the whole product (CAIRN-308). There were fourteen,
 * each a line of grey text in its own padding, so an empty list looked like a
 * page that had failed to load.
 *
 * Three small stones settle onto each other: the product's mark, at rest,
 * saying "nothing here yet" rather than "something broke". The top stone
 * takes the accent. `compact` is for panels and popovers, where the stones
 * would be too much.
 */
export const EmptyState = ({
  title,
  hint,
  action,
  compact = false,
  as: Title = 'p',
  className,
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean
  /** The title's element: `h1` where the empty state is the whole page. */
  as?: 'p' | 'h1' | 'h2'
  className?: string
}) => (
  <div
    className={cn(
      'enter-rise flex flex-col items-center justify-center text-center',
      compact ? 'gap-1 px-4 py-6' : 'gap-3 px-6 py-16',
      className,
    )}
  >
    {compact ? null : (
      <svg viewBox="0 0 40 30" className="h-8 w-auto" aria-hidden>
        <g className="login-stone" style={{ '--d': '60ms' } as React.CSSProperties}>
          <rect x="8" y="22" width="24" height="6" rx="3" fill="var(--border-strong)" />
        </g>
        <g className="login-stone" style={{ '--d': '160ms' } as React.CSSProperties}>
          <rect x="5" y="13.5" width="30" height="6.5" rx="3.25" fill="var(--border-strong)" opacity="0.8" />
        </g>
        <g className="login-stone" style={{ '--d': '260ms' } as React.CSSProperties}>
          <rect x="12" y="5" width="16" height="6.5" rx="3.25" fill="var(--accent)" opacity="0.85" />
        </g>
      </svg>
    )}
    <Title className={cn('text-fg-muted font-medium', compact ? 'text-meta' : 'text-ui')}>{title}</Title>
    {hint ? <p className="text-fg-subtle max-w-sm text-meta leading-relaxed">{hint}</p> : null}
    {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
  </div>
)
