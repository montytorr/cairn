import { cn } from '@/lib/utils'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'

/**
 * Status and priority marks, drawn rather than borrowed from an icon set.
 *
 * These two are the most-repeated pixels in the product — every row carries
 * both — so they are worth drawing exactly. A status ring encodes progress in
 * its fill, which reads down a column far faster than a word, and priority is
 * a bar chart for the same reason.
 */

const STATUS_META: Record<TaskStatus, { label: string; color: string; fill: number }> = {
  backlog: { label: 'Backlog', color: 'var(--status-backlog)', fill: 0 },
  todo: { label: 'Todo', color: 'var(--status-todo)', fill: 0 },
  doing: { label: 'In Progress', color: 'var(--status-doing)', fill: 0.5 },
  'in-review': { label: 'In Review', color: 'var(--status-in-review)', fill: 0.75 },
  done: { label: 'Done', color: 'var(--status-done)', fill: 1 },
  cancelled: { label: 'Cancelled', color: 'var(--status-cancelled)', fill: 1 },
}

export const StatusIcon = ({
  status,
  size = 14,
  className,
}: {
  status: TaskStatus
  size?: number
  className?: string
}) => {
  const meta = STATUS_META[status]
  const r = 6.5
  // A stroke-dasharray arc is how the partial fill is drawn: the ring is one
  // circle and the progress is a second, thicker one clipped by its dash.
  const circumference = 2 * Math.PI * 3.5

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('shrink-0', className)}
      aria-label={meta.label}
      role="img"
    >
      <title>{meta.label}</title>

      {status === 'backlog' ? (
        <circle
          cx="8"
          cy="8"
          r={r}
          stroke={meta.color}
          strokeWidth="1.5"
          strokeDasharray="1.6 1.8"
        />
      ) : (
        <circle cx="8" cy="8" r={r} stroke={meta.color} strokeWidth="1.5" />
      )}

      {meta.fill > 0 && meta.fill < 1 && (
        <circle
          cx="8"
          cy="8"
          r="3.5"
          stroke={meta.color}
          strokeWidth="7"
          strokeDasharray={`${circumference * meta.fill} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      )}

      {status === 'done' && (
        <>
          <circle cx="8" cy="8" r={r} fill={meta.color} />
          <path
            d="M5 8.2l2.1 2.1L11 6.4"
            stroke="var(--bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}

      {status === 'cancelled' && (
        <>
          <circle cx="8" cy="8" r={r} fill={meta.color} />
          <path
            d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  )
}

const PRIORITY_BARS: Record<TaskPriority, number> = { urgent: 0, high: 3, medium: 2, low: 1 }

/**
 * `aria-label` carries the accessible name; the `<title>` is belt and braces.
 *
 * It must be a SINGLE string child. React 19 treats `<title>` as hoistable
 * document metadata, and one whose children are an expression *plus* a literal
 * is emitted on the client but dropped by the server renderer — which showed
 * up as React #418 twenty-four times on a list page, and looked exactly like a
 * broken page.
 */
export const PriorityIcon = ({
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
      className={cn('shrink-0', className)}
      aria-label={`${label} priority`}
      role="img"
    >
      {/* One string child, not two: see the note on `aria-label` below. */}
      <title>{`${label} priority`}</title>
      {[
        { x: 1.5, y: 9.5, h: 5 },
        { x: 6.5, y: 6.5, h: 8 },
        { x: 11.5, y: 3.5, h: 11 },
      ].map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.h}
          rx="1"
          // Per priority, not one grey for all three. High, medium and low
          // differed only by how many bars were filled, which is a difference
          // you have to stop and count — invisible while scanning a list.
          fill={`var(--priority-${priority})`}
          opacity={i < filled ? 1 : 0.22}
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
 */
export const TypePill = ({ type }: { type: TaskType }) => {
  const color = `var(--type-${type})`
  return (
    <span
      className="inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-[11px] whitespace-nowrap"
      style={{
        color,
        // An unsupported color-mix is simply ignored, leaving the border the
        // class underneath draws.
        borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <span className="size-[7px] rounded-full" style={{ backgroundColor: color }} />
      {TYPE_LABEL[type]}
    </span>
  )
}

export const LabelPill = ({ children }: { children: React.ReactNode }) => (
  <span className="border-border text-fg-muted inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-[11px] whitespace-nowrap">
    <span
      className="size-[7px] rounded-full"
      style={{
        backgroundColor:
          typeof children === 'string' ? labelColor(children) : 'var(--fg-subtle)',
      }}
    />
    {children}
  </span>
)

/**
 * Initials avatar. Colour is derived from the name so the same actor is always
 * the same colour — which is what lets you recognise an agent without reading.
 */
const AVATAR_COLORS = ['#5e6ad2', '#4cb782', '#f2994a', '#eb5757', '#bb87fc', '#4ea7fc', '#26b5a2']

export const Avatar = ({ name, size = 18 }: { name: string; size?: number }) => {
  const initials = name
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.42 }}
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
