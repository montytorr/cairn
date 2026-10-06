import { cn } from '@/lib/utils'

/**
 * One settings section as an object: a header that says what it is, a body,
 * and an optional footer where the section's actions and its last message sit.
 * `flush` drops the body's padding for a list that runs edge to edge.
 */
export const SettingsCard = ({
  title,
  description,
  action,
  footer,
  flush = false,
  children,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
  flush?: boolean
  children?: React.ReactNode
}) => (
  <section className="surface-card overflow-hidden">
    <header className="border-border flex items-start gap-3 border-b px-4 py-3 md:px-5">
      <div className="min-w-0 flex-1">
        <h2 className="text-fg text-ui font-medium">{title}</h2>
        {description ? (
          <p className="text-fg-subtle mt-1 text-meta leading-relaxed">{description}</p>
        ) : null}
      </div>
      {action ? <div className="-mr-1 shrink-0">{action}</div> : null}
    </header>
    {children ? <div className={cn(!flush && 'px-4 py-4 md:px-5')}>{children}</div> : null}
    {footer ? (
      <footer className="border-border bg-surface-raised/30 flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5 md:px-5">
        {footer}
      </footer>
    ) : null}
  </section>
)
