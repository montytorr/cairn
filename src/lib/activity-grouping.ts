import type { ActivityRow } from '@/lib/api/activity-feed'

/**
 * Collapses a run of events that are really one action.
 *
 * Filing a task writes four rows within the same second — the task itself,
 * plus `created`, `claimed` and `status_changed` on it — and each repeats the
 * same title. Four lines of identical text is not more information than one;
 * it is the same information made harder to read, and a feed that does that
 * teaches the reader to skim past exactly the days worth reading.
 *
 * The merge condition is a shared ref AND an identical title, which is precise
 * rather than lucky: task and event rows carry the task's title, so they
 * collapse together, while a note or a comment carries its own text and never
 * merges with anything.
 */
export type ActivityGroup = ActivityRow & { details: string[]; merged: number }

export const groupActivity = (rows: ActivityRow[]): ActivityGroup[] => {
  const out: ActivityGroup[] = []

  for (const row of rows) {
    const last = out.at(-1)
    const sameThing = last && last.ref === row.ref && last.title === row.title

    if (sameThing) {
      if (row.detail && !last.details.includes(row.detail)) last.details.push(row.detail)
      last.merged += 1
      continue
    }

    out.push({ ...row, details: row.detail ? [row.detail] : [], merged: 1 })
  }

  return out
}
