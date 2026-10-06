import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'

/**
 * Status and priority marks, drawn rather than borrowed from an icon set.
 *
 * These two are the most-repeated pixels in the product — every row carries
 * both — so they are worth drawing exactly. A status ring encodes progress in
 * its fill, which reads down a column far faster than a word, and priority is
 * a bar chart for the same reason.
 *
 * Every layer is always drawn and only its attributes change, so a status or
 * priority edited in place moves to its new value — the pie sweeps, the disk
 * fills, the tick draws, a bar grows — rather than being swapped for a
 * different drawing. A transition never runs on first paint, so a list that
 * is only arriving stays still.
 */

const STATUS_META: Record<TaskStatus, { label: string; color: string; fill: number }> = {
  backlog: { label: 'Backlog', color: 'var(--status-backlog)', fill: 0 },
  todo: { label: 'Todo', color: 'var(--status-todo)', fill: 0 },
  doing: { label: 'In Progress', color: 'var(--status-doing)', fill: 0.5 },
  'in-review': { label: 'In Review', color: 'var(--status-in-review)', fill: 0.75 },
  done: { label: 'Done', color: 'var(--status-done)', fill: 1 },
  cancelled: { label: 'Cancelled', color: 'var(--status-cancelled)', fill: 1 },
}

const UNKNOWN_STATUS = { label: 'Unknown status', color: 'var(--fg-subtle)', fill: 0 }

// One motion for every layer of both marks: the settle, at the longest step.
const SETTLE = 'duration-[var(--dur-3)] ease-[var(--ease-out)]'

// Scaled about its own middle, not the SVG origin.
const OWN_CENTRE = { transformBox: 'fill-box', transformOrigin: 'center' } as const

const StatusIconBase = ({
  status,
  size = 14,
  className,
}: {
  status: TaskStatus
  size?: number
  className?: string
}) => {
  // A status this build does not know (an older API, a hit from another
  // index) draws a neutral ring rather than taking the whole palette down.
  const meta = STATUS_META[status] ?? UNKNOWN_STATUS
  const r = 6.5
  const closed = status === 'done' || status === 'cancelled'
  // A stroke-dasharray arc is how the partial fill is drawn: the ring is one
  // circle and the progress is a second, thicker one clipped by its dash. The
  // dash is a full circumference and the offset hides what is not yet done,
  // so a change of status is a change of one number the browser can tween.
  const circumference = 2 * Math.PI * 3.5
  const progress = closed ? 1 : meta.fill

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('shrink-0 transition-[color]', SETTLE, className)}
      style={{ color: meta.color }}
      aria-label={meta.label}
      role="img"
    >
      <title>{meta.label}</title>

      <circle
        cx="8"
        cy="8"
        r={r}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={status === 'backlog' ? '1.6 1.8' : undefined}
      />

      <circle
        cx="8"
        cy="8"
        r="3.5"
        stroke="currentColor"
        strokeWidth="7"
        // The gap is a hair longer than the path, so a fully hidden arc
        // leaves no sliver at its seam.
        strokeDasharray={`${circumference} ${circumference + 1}`}
        transform="rotate(-90 8 8)"
        style={{ strokeDashoffset: circumference * (1 - progress) }}
        className={cn('transition-[stroke-dashoffset]', SETTLE)}
      />

      <circle
        cx="8"
        cy="8"
        r={r}
        fill="currentColor"
        style={{ fillOpacity: closed ? 1 : 0 }}
        className={cn('transition-[fill-opacity]', SETTLE)}
      />

      {/* The tick draws itself once the disk has filled behind it. */}
      <path
        d="M5 8.2l2.1 2.1L11 6.4"
        stroke="var(--bg)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray="1 1"
        style={{ strokeDashoffset: status === 'done' ? 0 : 1, opacity: status === 'done' ? 1 : 0 }}
        className={cn('transition-[stroke-dashoffset,opacity] delay-[var(--dur-1)]', SETTLE)}
      />

      <path
        d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
        stroke="var(--bg)"
        strokeWidth="1.5"
        strokeLinecap="round"
        style={{
          ...OWN_CENTRE,
          opacity: status === 'cancelled' ? 1 : 0,
          transform: status === 'cancelled' ? undefined : 'scale(0.6)',
        }}
        className={cn('transition-[opacity,transform] delay-[var(--dur-1)]', SETTLE)}
      />
    </svg>
  )
}

const PRIORITY_BARS: Record<TaskPriority, number> = { urgent: 0, high: 3, medium: 2, low: 1 }

const BARS = [
  { x: 1.5, y: 9.5, h: 5 },
  { x: 6.5, y: 6.5, h: 8 },
  { x: 11.5, y: 3.5, h: 11 },
]

/**
 * `aria-label` carries the accessible name; the `<title>` is belt and braces.
 *
 * It must be a SINGLE string child. React 19 treats `<title>` as hoistable
 * document metadata, and one whose children are an expression *plus* a literal
 * is emitted on the client but dropped by the server renderer — which showed
 * up as React #418 twenty-four times on a list page, and looked exactly like a
 * broken page.
 */
const PriorityIconBase = ({
  priority,
  size = 14,
  className,
}: {
  priority: TaskPriority
  size?: number
  className?: string
}) => {
  // Urgent breaks the pattern deliberately: it is the one value that should
  // stop the eye rather than be compared against its neighbours.
  if (priority === 'urgent') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className={cn('shrink-0', className)}
        aria-label="Urgent"
        role="img"
      >
        <title>Urgent</title>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="var(--priority-urgent)" />
        <rect x="7" y="4" width="2" height="5" rx="1" fill="var(--bg)" />
        <rect x="7" y="10.5" width="2" height="2" rx="1" fill="var(--bg)" />
      </svg>
    )
  }

  const filled = PRIORITY_BARS[priority]
  const label = priority.charAt(0).toUpperCase() + priority.slice(1)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      // Per priority, not one grey for all three. High, medium and low
      // differed only by how many bars were filled, which is a difference
      // you have to stop and count — invisible while scanning a list.
      className={cn('shrink-0 transition-[color]', SETTLE, className)}
      style={{ color: `var(--priority-${priority})` }}
      aria-label={`${label} priority`}
      role="img"
    >
      {/* One string child, not two: see the note on `aria-label` below. */}
      <title>{`${label} priority`}</title>
      {/* A faint track under every bar, and the filled bar over it, grown up
          from its base — so raising a priority fills the next bar in rather
          than switching it on. */}
      {BARS.map((bar) => (
        <rect key={`t${bar.x}`} x={bar.x} y={bar.y} width="3" height={bar.h} rx="1" fill="currentColor" opacity={0.22} />
      ))}
      {BARS.map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.h}
          rx="1"
          fill="currentColor"
          style={{
            transformBox: 'fill-box',
            transformOrigin: 'bottom',
            transform: i < filled ? undefined : 'scaleY(0)',
            transitionDelay: `${i * 40}ms`,
          }}
          className={cn('transition-transform', SETTLE)}
        />
      ))}
    </svg>
  )
}

const TYPE_LABEL: Record<TaskType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  improvement: 'Improvement',
  chore: 'Chore',
  spike: 'Spike',
  docs: 'Docs',
}

/**
 * The type of a task, on every row.
 *
 * The colour used to be a 7px dot beside grey text, which is the smallest
 * possible place to put the one attribute that says what kind of work this is.
 * The text now carries it too, and the border takes a wash of it — each value
 * has a theme-specific hex chosen to clear 4.5 against that theme's ground,
 * which is why they are tokens rather than one shared palette.
 *
 * Both pills are one shape: the same height, a soft fill of their own colour
 * and a hairline rim of it, so a row carrying a type and two labels reads as
 * one set of chips rather than three styles.
 */
const PILL =
  'inline-flex h-[1.25rem] shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-meta leading-none whitespace-nowrap ' +
  'transition-[color,background-color,border-color] duration-[var(--dur-2)] ease-[var(--ease-out)]'

// An unsupported color-mix is simply ignored, leaving the border the class
// underneath draws.
const tint = (color: string, rim: number, wash: number): React.CSSProperties => ({
  borderColor: `color-mix(in oklab, ${color} ${rim}%, transparent)`,
  backgroundColor: `color-mix(in oklab, ${color} ${wash}%, transparent)`,
})

export const TypePill = ({ type }: { type: TaskType }) => {
  const color = `var(--type-${type})`
  return (
    <span className={PILL} style={{ color, ...tint(color, 34, 10) }}>
      <span className="size-[0.4375rem] rounded-full" style={{ backgroundColor: color }} />
      {TYPE_LABEL[type]}
    </span>
  )
}

export const LabelPill = ({ children }: { children: React.ReactNode }) => {
  const color = typeof children === 'string' ? labelColor(children) : 'var(--fg-subtle)'
  // The text stays grey: the derived palette is not measured against either
  // ground the way the type tokens are, so it colours the chip, not the word.
  return (
    <span className={cn(PILL, 'text-fg-muted')} style={tint(color, 28, 8)}>
      <span className="size-[0.4375rem] rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  )
}

/**
 * Initials avatar. Colour is derived from the name so the same actor is always
 * the same colour — which is what lets you recognise an agent without reading.
 */
// Each carries white initials at 4.5:1 or better (contrast.test.ts).
export const AVATAR_COLORS = ['#4f5bc4', '#1b7a4f', '#a8500a', '#c02f2f', '#7c3aed', '#1c6bc9', '#0f766e']

/** Initials are never set below 13px, so the circle never goes below 22px. */
export const Avatar = ({ name, size: requested = 18 }: { name: string; size?: number }) => {
  const size = Math.max(22, requested)
  const initials = name
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, size < 26 ? 1 : 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, backgroundColor: color, fontSize: Math.max(13, size * 0.42) }}
      title={name}
    >
      {initials || '?'}
    </span>
  )
}

/**
 * A wider palette than the avatars use: 33 projects through 7 colours puts
 * near-neighbours in the sidebar on the same hue, which defeats the point.
 */
const PROJECT_COLORS = [
  '#5e6ad2', '#4cb782', '#f2994a', '#eb5757', '#bb87fc', '#4ea7fc', '#26b5a2',
  '#d4a72c', '#e06c9f', '#7b8794', '#6ec7c0', '#a3874f',
]

/** Stable across renders, machines and reloads — it is derived, not stored. */
const pick = (key: string, palette: readonly string[]) => {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return palette[hash % palette.length] as string
}

export const projectColor = (key: string) => pick(key, PROJECT_COLORS)

/**
 * A label's own colour, derived the same way.
 *
 * Every label dot was the same grey, so a row carrying three labels carried
 * three identical marks and the colour said nothing. Deriving it means a label
 * looks the same everywhere it appears without anybody choosing or storing a
 * colour — and `bug` reads differently from `infra` at a glance.
 */
export const labelColor = (label: string) => pick(label, PROJECT_COLORS)

/**
 * A world's own colour, derived the same way.
 *
 * An entity groups projects — a business, a stack, a subsystem — and on the
 * map it is drawn as the region its projects settled into. Its colour has to
 * come from the same palette as theirs or the region fights the dots inside
 * it, and it has to be derived rather than stored for the same reason every
 * other colour here is: nobody should have to choose one.
 */
export const entityColor = (key: string) => pick(key, PROJECT_COLORS)

/**
 * The hexagon Linear uses for a project.
 *
 * Given a project key it takes that project's colour, filled rather than only
 * stroked: at 12-13px a 1.3px outline in a mid grey is close to invisible, and
 * the whole point is telling one project's rows from another's at a glance.
 */
export const ProjectIcon = ({ size = 13, projectKey }: { size?: number; projectKey?: string }) => {
  const color = projectKey ? projectColor(projectKey) : undefined
  return (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className="shrink-0"
    style={color ? { color } : undefined}
    aria-hidden
  >
    <path
      d="M8 1.5l5.2 3v6l-5.2 3-5.2-3v-6l5.2-3z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      fill={color ? 'currentColor' : 'none'}
      fillOpacity={color ? 0.24 : 0}
    />
  </svg>
  )
}

/**
 * Memoised: every row of a 300-task list draws both, and each now carries
 * every layer of its shape so a change can animate between them. Pure by
 * props, so a row that re-renders for any other reason skips them.
 */
export const StatusIcon = memo(StatusIconBase)
export const PriorityIcon = memo(PriorityIconBase)
