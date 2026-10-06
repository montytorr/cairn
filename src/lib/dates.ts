/**
 * Date formatting that survives hydration.
 *
 * `toLocaleDateString` with no `timeZone` resolves to the *runtime's* zone:
 * UTC in the container, Europe/Paris in the browser. Any timestamp near
 * midnight then renders as a different string on each side, and React throws
 * a hydration mismatch (#418) per offending row. With closed tasks included
 * that was ten errors and a visibly broken repaint on every project page.
 *
 * So every formatter here pins the zone explicitly, and anything that depends
 * on "now" is deferred to after mount rather than guessed at on the server.
 */
export const DISPLAY_TZ = process.env.NEXT_PUBLIC_CAIRN_TZ || 'Europe/Paris'

const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: DISPLAY_TZ, ...options })

const SHORT = fmt({ day: 'numeric', month: 'short' })
const SHORT_YEAR = fmt({ day: 'numeric', month: 'short', year: 'numeric' })
const FULL = fmt({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** `10 Sept` — a list shows a short date, never a timestamp. */
export const shortDate = (iso: string) => SHORT.format(new Date(iso))

/** `10 Sept 2025` — for anything that might be from a previous year. */
export const shortDateWithYear = (iso: string) => SHORT_YEAR.format(new Date(iso))

/** `10 Sept 2026, 18:43` — for tooltips, where precision is the point. */
export const fullDateTime = (iso: string) => FULL.format(new Date(iso))

const TIME = fmt({ hour: '2-digit', minute: '2-digit' })

/** `18:43` — the sessions timeline shows the date once, as a day header. */
export const timeOfDay = (iso: string) => TIME.format(new Date(iso))

/**
 * `3m ago`. Pure, so the caller decides what "now" is — which is what lets a
 * component render the absolute date on the server and refine it in the
 * browser without the two disagreeing.
 */
export const relativeTime = (iso: string, now: number) => {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 86_400 * 7) return `${Math.round(seconds / 86_400)}d ago`
  return shortDate(iso)
}

// `en-CA` is the one locale whose everyday format is already `YYYY-MM-DD` —
// the same shape `due_date` is stored in, so the two compare as strings with
// no parsing on either side.
const ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today's calendar date in the display zone, as `2026-09-29`. */
export const todayDate = (now: number = Date.now()) => ISO_DATE.format(new Date(now))

/** `2026-09-29` for an instant, in the display zone — never `iso.slice(0, 10)`, which is the UTC day. */
export const localDay = (iso: string) => ISO_DATE.format(new Date(iso))

/**
 * The due-date row's label and tone. Pure and given "today" explicitly, for
 * the same reason `relativeTime` takes `now`: a component can gate the real
 * value behind a mounted check without this helper reading the clock itself.
 *
 * A closed task is never overdue — the date is history once the work is
 * done, not a warning — and the due date itself is never overdue, only the
 * days after it.
 */
export const dueDateDisplay = (
  dueDate: string | null,
  closed: boolean,
  todayIso: string,
): { label: string; overdue: boolean } => {
  if (!dueDate) return { label: 'No due date', overdue: false }
  return { label: shortDateWithYear(dueDate), overdue: !closed && dueDate < todayIso }
}
