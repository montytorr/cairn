import Link from 'next/link'
import {
  BookMarked,
  CirclePlus,
  FlaskConical,
  GitCommitHorizontal,
  ListTodo,
  MessageSquare,
  PenLine,
  Terminal,
} from 'lucide-react'
import { Avatar, ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { DISPLAY_TZ, localDay, timeOfDay } from '@/lib/dates'
import type { ActivityRow } from '@/lib/api/activity-feed'
import { groupActivity, type ActivityGroup } from '@/lib/activity-grouping'

/**
 * One glyph and one colour per kind, so a mixed feed can be scanned by shape.
 *
 * The previous set was picked for availability rather than meaning: Shuffle —
 * which means reorder — stood for a status change, and Radio, which means
 * broadcast, stood for an agent working in a terminal. At 13px in a single
 * grey they were six versions of "something happened".
 *
 * `GitCommitHorizontal` is the timeline glyph for a thing that occurred at a
 * point; `PenLine` is someone writing as they work; `Terminal` is a session.
 * Each keeps a fixed colour, which is what makes the column sortable by eye.
 */
const KIND: Record<
  ActivityRow['kind'],
  { label: string; Icon: typeof ListTodo; color: string }
> = {
  task: { label: 'filed', Icon: CirclePlus, color: 'var(--accent)' },
  event: { label: 'changed', Icon: GitCommitHorizontal, color: 'var(--fg-subtle)' },
  note: { label: 'note', Icon: PenLine, color: 'var(--status-todo)' },
  comment: { label: 'comment', Icon: MessageSquare, color: 'var(--status-in-review)' },
  session: { label: 'session', Icon: Terminal, color: 'var(--status-doing)' },
  knowledge: { label: 'knowledge', Icon: BookMarked, color: 'var(--status-done)' },
}

/**
 * A Lab subject's row: its ref is `LAB-<n>`, and `LAB` is reserved, so no
 * project's task is ever one. Only present while the Lab is on.
 */
const subjectNumberOf = (row: Pick<ActivityRow, 'ref'>): string | null =>
  /^LAB-\d+$/.test(row.ref) ? row.ref.slice('LAB-'.length) : null

/** Where a row leads. A session has no page of its own, and its useful content
 *  is the line already shown, so it stays unlinked rather than pointing at a
 *  list the reader is already looking at. */
export const hrefFor = (row: ActivityRow): string | null => {
  if (row.kind === 'knowledge') return `/knowledge/${row.ref}`
  if (row.kind === 'session') return null
  const subject = subjectNumberOf(row)
  if (subject) return `/lab/subjects/${subject}`
  const [key, number] = row.ref.split('-')
  if (key && number) return `/projects/${key}/tasks/${number}`
  // An event about the project itself — renamed, re-keyed, archived — carries
  // the project's live key as its ref and no number. It was unlinked, so the
  // one row saying "AC is now HOL" led nowhere.
  if (row.kind === 'event' && row.project_key) return `/projects/${row.project_key.split(',')[0]}`
  return null
}

/**
 * What a project event says when the feed supplied no title. Until the feed
 * reads `data.from`/`data.to` for these, a key change arrived as a blank line;
 * a sentence naming the live key is less than it should say, and more than
 * nothing.
 */
const PROJECT_EVENT: Record<string, (key: string) => string> = {
  project_key_changed: (key) => `Project key changed — now ${key}`,
  project_renamed: (key) => `Project ${key} renamed`,
  project_archived: (key) => `Project ${key} archived`,
  project_restored: (key) => `Project ${key} restored`,
  project_described: (key) => `Project ${key} description changed`,
}

export const titleFor = (row: ActivityRow): string => {
  if (row.title.trim()) return row.title
  const describe = row.detail ? PROJECT_EVENT[row.detail] : undefined
  return describe ? describe(row.project_key?.split(',')[0] ?? row.ref) : row.title
}

/**
 * The trail: a dotted line down the feed, one stone on it per event, and a
 * small cairn where each day begins. The dot sits level with the kind tile
 * (row padding 0.5rem + the tile's 1px offset + half its 1.25rem), so the
 * line reads as passing through the icons rather than beside them.
 *
 * Drawn per row rather than once per day, so the first stone of a day starts
 * the line and the last one ends it — a trail that runs past its final cairn
 * into empty space reads as unfinished.
 */
const STONE_Y = '1.1875rem'

const Trail = ({ color }: { color: string }) => (
  <span aria-hidden className="relative -my-2 w-2 shrink-0 self-stretch">
    <span
      className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[linear-gradient(to_bottom,var(--border-strong)_40%,transparent_0)] bg-[length:1px_5px] group-first:top-[var(--stone-y)] group-last:bottom-auto group-last:h-[var(--stone-y)] group-only:hidden"
      style={{ '--stone-y': STONE_Y } as React.CSSProperties}
    />
    <span
      className="absolute top-4 left-1/2 h-1.5 w-2 -translate-x-1/2 rounded-full"
      style={{ backgroundColor: color }}
    />
  </span>
)

/** A small cairn on the trail where a day begins: three stones, the top one lit. */
const DayCairn = () => (
  <span aria-hidden className="flex w-2 shrink-0 justify-center">
    <svg viewBox="0 0 10 10" className="size-2.5 overflow-visible">
      <rect x="0.5" y="7.2" width="9" height="2.3" rx="1.15" fill="var(--fg-subtle)" opacity="0.5" />
      <rect x="1.8" y="4.3" width="6.4" height="2.3" rx="1.15" fill="var(--fg-subtle)" opacity="0.8" />
      <rect x="3" y="1.4" width="4" height="2.3" rx="1.15" fill="var(--accent)" />
    </svg>
  </span>
)

// A hairline between events that starts at the kind tile, so it never cuts
// across the trail: px-4 + time 2.375rem + gap + trail 0.5rem + gap.
const ROW =
  'group relative block after:pointer-events-none after:absolute after:right-0 after:bottom-0 after:left-[5.125rem] after:h-px after:bg-border/70 last:after:hidden'

const Row = ({ row }: { row: ActivityGroup }) => {
  const isSubject = subjectNumberOf(row) !== null
  // A subject's rows keep their own verbs (filed, changed, note) in the Lab's
  // colour and glyph, so the feed shows at a glance which are lab work.
  const { label, Icon, color } = isSubject
    ? { ...KIND[row.kind], Icon: FlaskConical, color: 'var(--status-in-review)' }
    : KIND[row.kind]
  const href = hrefFor(row)
  const time = timeOfDay(row.at)

  const body = (
    <div className="flex min-w-0 items-start gap-2.5 px-4 py-2">
      <span className="text-fg-subtle w-[2.375rem] shrink-0 pt-[2px] text-meta tabular-nums">
        {time}
      </span>

      <Trail color={color} />

      {/* A tinted tile rather than a bare glyph: at 13px on a near-black
          ground a line icon has almost no presence, and the column is the
          only thing telling twelve identical-looking rows apart. */}
      <span
        className="mt-[1px] grid size-[1.25rem] shrink-0 place-items-center rounded-md"
        style={{
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 22%, transparent)`,
          color,
        }}
        aria-hidden
      >
        <Icon size={12} />
      </span>

      {/* What happened, then the particulars.
          The other way round — a line of avatar, kind, sub-kinds and ref above
          the content — meant every row opened with five pieces of chrome in the
          same grey before saying anything, and a timeline you cannot skim by
          content is a list of timestamps. */}
      <div className="min-w-0 flex-1">
        <p className="text-fg line-clamp-2 text-ui leading-snug">{titleFor(row)}</p>

        <div className="text-fg-subtle mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta">
          <span style={{ color }}>{label}</span>
          {row.details
            .filter((d) => d !== label)
            .map((d) => (
              <span key={d}>· {d.replace(/_/g, ' ')}</span>
            ))}
          {isSubject && !row.project_key && (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden>·</span>
              <span className="text-fg-muted font-mono">{row.ref}</span>
            </span>
          )}
          {row.project_key && (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden>·</span>
              <ProjectIcon size={10} projectKey={row.project_key.split(',')[0]} />
              <span className="text-fg-muted font-mono">{row.ref}</span>
            </span>
          )}
          {row.actor && (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden>·</span>
              {/* Small enough to identify without announcing itself: on a feed
                  where one agent writes most rows, a filled avatar on every
                  line is the loudest thing on the page and the least
                  informative. */}
              <Avatar name={row.actor} size={11} />
              <span className="truncate">{row.actor}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )

  return href ? (
    <Link href={href} className={cn(ROW, 'row-hover')}>
      {body}
    </Link>
  ) : (
    <div className={ROW}>{body}</div>
  )
}

export const ActivityList = ({ rows }: { rows: ActivityRow[] }) => {
  // Group before splitting into days: a run that straddles midnight is still
  // one action, and splitting first would leave half of it in each day.
  const days = new Map<string, ActivityGroup[]>()
  for (const row of groupActivity(rows)) {
    const day = localDay(row.at)
    days.set(day, [...(days.get(day) ?? []), row])
  }

  return (
    <div>
      {[...days].map(([day, items]) => (
        <section key={day}>
          <h2 className="group-band border-border text-fg sticky top-0 z-10 flex items-center gap-2.5 border-b px-4 py-2 text-meta font-medium">
            <span aria-hidden className="w-[2.375rem] shrink-0" />
            <DayCairn />
            {new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: DISPLAY_TZ,
            })}
          </h2>
          <div className="stagger">
            {items.map((row, i) => (
              <Row key={`${row.kind}:${row.ref}:${row.at}:${i}`} row={row} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
