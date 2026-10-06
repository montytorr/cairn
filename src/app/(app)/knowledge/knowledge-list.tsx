import Link from 'next/link'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { LabelPill, ProjectIcon, entityColor, projectColor } from '@/components/icons'
import { shortDate, fullDateTime } from '@/lib/dates'
import { cn } from '@/lib/utils'

export type KnowledgeListItem = {
  slug: string
  title: string
  labels: string[]
  projects: string[]
  entities: string[]
  verified: boolean
  updatedAt: string
  superseded: boolean
  /** The replacement to link to. Known for a browse row; a search hit only
   *  knows the boolean above, since search_all does not carry the id. */
  supersededByRef: { slug: string; title: string } | null
  /** Set on a search hit; not carried by a browse row. */
  loose?: boolean
}

/**
 * A scope pill, cut to the same shape and tint as `LabelPill` — a soft fill of
 * the thing's own colour, a hairline of the same colour — so labels and scope
 * on a row read as one set of chips, and the title stays the brightest thing
 * on the line. Exported for the entry page, which shows the same chips.
 */
export const TintPill = ({
  color,
  children,
  className,
}: {
  color: string
  children: React.ReactNode
  className?: string
}) => (
  <span
    className={cn(
      'text-fg-muted inline-flex h-[1.25rem] shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-[0.6875rem] leading-none whitespace-nowrap',
      className,
    )}
    style={{
      borderColor: `color-mix(in oklab, ${color} 28%, transparent)`,
      backgroundColor: `color-mix(in oklab, ${color} 8%, transparent)`,
    }}
  >
    {children}
  </span>
)

/**
 * How widely a fact applies, in one shape.
 *
 * A project used to render as an icon and a key, an entity as bare text, and
 * global as a grey italic word — three treatments for one field, so the column
 * read as three unrelated things rather than one answer at three widths.
 */
const Scope = ({ item }: { item: KnowledgeListItem }) => {
  if (item.projects.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {item.projects.map((p) => (
          <TintPill key={p} color={projectColor(p)}>
            <ProjectIcon size={10} projectKey={p} />
            {p}
          </TintPill>
        ))}
      </span>
    )
  }
  if (item.entities.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {item.entities.map((e) => (
          <TintPill key={e} color={entityColor(e)}>
            <span className="size-[0.4375rem] rounded-full" style={{ backgroundColor: entityColor(e) }} aria-hidden />
            {e}
          </TintPill>
        ))}
      </span>
    )
  }
  return (
    <TintPill color="var(--fg-subtle)" className="text-fg-subtle">
      <span className="bg-fg-subtle size-[0.4375rem] rounded-full opacity-60" aria-hidden />
      everywhere
    </TintPill>
  )
}

export const KnowledgeList = ({ items }: { items: KnowledgeListItem[] }) => (
  <ul className="divide-border/70 stagger divide-y">
    {items.map((item) => (
      // The hover lives on the row, not the inner line: the link is laid over
      // the whole row, so the line underneath it is never the thing hovered.
      <li key={item.slug} className="group row-hover relative">
        <Link
          href={`/knowledge/${item.slug}`}
          prefetch
          aria-label={item.title}
          className="absolute inset-0 z-0"
        />
        {/* One line, like a task row.
            Two lines per entry made this the only list in the product with its
            own rhythm — a knowledge list beside a task list read as two
            different applications. Everything after the title is metadata and
            belongs on the same line, ranked right. */}
        <div className="flex h-[2.5rem] min-w-0 items-center gap-2 px-3 sm:px-4">
          <span
            className={cn(
              'pointer-events-none min-w-0 flex-1 truncate text-[0.8125rem]',
              item.superseded ? 'text-fg-muted line-through decoration-1' : 'text-fg',
            )}
          >
            {item.title}
          </span>

          {item.verified && (
            <span title="Verified" className="text-status-in-review pointer-events-none shrink-0">
              <ShieldCheck size={13} aria-hidden />
            </span>
          )}

          {item.loose && (
            <span className="text-fg-subtle pointer-events-none shrink-0 text-[0.6875rem]">
              loose
            </span>
          )}

          {item.superseded &&
            (item.supersededByRef ? (
              <Link
                href={`/knowledge/${item.supersededByRef.slug}`}
                prefetch
                title={`Superseded by ${item.supersededByRef.title}`}
                className="text-accent pointer-events-auto relative z-10 hidden shrink-0 items-center gap-1 text-[0.6875rem] hover:underline sm:flex"
              >
                <ArrowRight size={11} aria-hidden />
                superseded
              </Link>
            ) : (
              <span className="text-fg-subtle pointer-events-none shrink-0 text-[0.6875rem]">
                superseded
              </span>
            ))}

          {item.labels.length > 0 && (
            <span className="pointer-events-none hidden shrink-0 items-center gap-1 lg:flex">
              {item.labels.slice(0, 3).map((l) => (
                <LabelPill key={l}>{l}</LabelPill>
              ))}
              {item.labels.length > 3 && (
                <span className="text-fg-subtle text-[0.6875rem] tabular-nums">+{item.labels.length - 3}</span>
              )}
            </span>
          )}

          <span className="pointer-events-none hidden shrink-0 sm:block">
            <Scope item={item} />
          </span>

          <time
            dateTime={item.updatedAt}
            title={fullDateTime(item.updatedAt)}
            className="text-fg-subtle tabular hidden w-[2.875rem] shrink-0 text-right text-[0.75rem] md:block"
          >
            {shortDate(item.updatedAt)}
          </time>
        </div>
      </li>
    ))}
  </ul>
)
