import { DISPLAY_TZ } from '@/lib/dates'

/**
 * Day headers for the sessions timeline, computed in the pinned display zone
 * for the same reason every formatter in dates.ts is: an unzoned split would
 * put a session either side of midnight in a different day on the server than
 * in the browser.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export const dayKey = (iso: string): string => DAY.format(new Date(iso))

export type DayGroup<T> = { day: string; rows: T[] }

/**
 * Rows into day groups, assuming they arrive newest-first (what listSessions
 * always returns). That ordering is what makes a single linear pass correct:
 * once a day's run ends it never recurs, so there is no need to sort groups
 * afterwards.
 */
export const groupByDay = <T extends { endedAt: string | null }>(rows: T[]): DayGroup<T>[] => {
  const groups: DayGroup<T>[] = []
  for (const row of rows) {
    const day = row.endedAt ? dayKey(row.endedAt) : 'No end time recorded'
    const current = groups.at(-1)
    if (current && current.day === day) current.rows.push(row)
    else groups.push({ day, rows: [row] })
  }
  return groups
}
