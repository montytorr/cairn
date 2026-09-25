import { pool } from '@/lib/db/client'

/**
 * How often each fact is recalled (CAIRN-270), from what 053 already records:
 * searches that returned it and direct reads that fetched it. Not counted: the
 * session briefing and `cairn recall`, which record nothing — every surface
 * showing these numbers has to say so, or an entry the briefing shows daily
 * reads as dead.
 */

export const RECALL_WINDOW_DAYS = 30

export const COUNTED =
  'counts check/know searches that returned it and direct reads; the session briefing and cairn recall are not recorded'

export type RecallCount = {
  returned: number
  read: number
  lastRecalled: string | null
}

const since = (days: number) =>
  Number.isFinite(days) ? new Date(Date.now() - days * 86_400_000).toISOString() : '-infinity'

export const recallCounts = async (
  ids: string[],
  days = RECALL_WINDOW_DAYS,
): Promise<Map<string, RecallCount>> => {
  const out = new Map<string, RecallCount>()
  if (ids.length === 0) return out
  const { rows } = await pool().query(
    'select knowledge_id, returned, read, last_recalled from knowledge_recall_counts($1, $2::uuid[])',
    [since(days), ids],
  )
  for (const r of rows) {
    out.set(r.knowledge_id as string, {
      returned: r.returned as number,
      read: r.read as number,
      lastRecalled: r.last_recalled ? new Date(r.last_recalled as string).toISOString() : null,
    })
  }
  return out
}

export type UnusedEntry = {
  slug: string
  title: string
  createdAt: string
  /** Ever, not just in the window. Null means no record of it being recalled at all. */
  lastRecalled: string | null
}

/**
 * Current entries nobody was given in `days`, never-recalled first. An entry younger
 * than the window is left out: it has not had the chance.
 *
 * Reads `knowledge_recall_state` (062), which the telemetry triggers keep
 * current, so the work is bounded by `limit` rather than growing with every
 * search and read ever recorded. Two halves, each walked through its own index
 * and cut at the limit: never-recalled entries oldest first, then entries whose
 * last recall is before the window, oldest recall first. "Unused in the window"
 * is the same test as knowledge_recall_counts(since) returning zero for both
 * counts: no recall at or after `since`.
 */
export const unusedKnowledge = async (days: number, limit: number): Promise<UnusedEntry[]> => {
  const { rows } = await pool().query(
    `select * from (
       (select k.id, k.slug, k.title, k.created_at, null::timestamptz as last_recalled_at
          from knowledge k
         where k.superseded_by is null
           and k.created_at < $1
           and not exists (select 1 from knowledge_recall_state s where s.knowledge_id = k.id)
         order by k.created_at asc, k.id asc
         limit $2)
       union all
       (select k.id, k.slug, k.title, k.created_at, s.last_recalled_at
          from knowledge_recall_state s
          join knowledge k on k.id = s.knowledge_id
         where s.last_recalled_at < $1
           and k.superseded_by is null
           and k.created_at < $1
         order by s.last_recalled_at asc, k.created_at asc, k.id asc
         limit $2)
     ) ranked
     order by last_recalled_at asc nulls first, created_at asc, id asc
     limit $2`,
    [since(days), limit],
  )
  return rows.map((r) => ({
    slug: r.slug as string,
    title: r.title as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    lastRecalled: r.last_recalled_at ? new Date(r.last_recalled_at as string).toISOString() : null,
  }))
}

export type UnusedWindow = {
  /** Days since the oldest current entry was written. Null for an empty store. */
  storeAgeDays: number | null
  /** Set when no current entry is old enough to qualify: a zero that means "not yet", not "none". */
  note?: string
}

/**
 * Whether `--unused <days>` can say anything at all yet.
 *
 * An entry younger than the window is left out, which is right one at a time
 * and wrong for the whole store: 30 days after an import every entry is still
 * inside the window, the answer is an empty list, and an empty list reads as
 * "everything is being used" (CAIRN-289 — a 10-day window showed 46).
 */
export const unusedWindow = async (days: number): Promise<UnusedWindow> => {
  const { rows } = await pool().query(
    'select min(created_at) as oldest from knowledge where superseded_by is null',
  )
  const oldest = rows[0]?.oldest ? Date.parse(new Date(rows[0].oldest as string).toISOString()) : null
  if (oldest === null || Number.isNaN(oldest)) return { storeAgeDays: null }
  const storeAgeDays = Math.floor((Date.now() - oldest) / 86_400_000)
  if (storeAgeDays >= days) return { storeAgeDays }
  return {
    storeAgeDays,
    note:
      `the oldest current entry is ${storeAgeDays} day${storeAgeDays === 1 ? '' : 's'} old, younger than ` +
      `the ${days}-day window, so nothing can qualify yet — try --unused ${Math.max(1, storeAgeDays - 1)}`,
  }
}
