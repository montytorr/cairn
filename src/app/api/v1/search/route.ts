import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { searchAll, searchTasks, type SearchAllRow, type SearchRow } from '@/lib/api/search'
import { recordSearch } from '@/lib/api/search-events'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'
import { admin } from '@/lib/db/client'
import { stalenessFor } from '@/lib/api/staleness'
import { liveProjectKey } from '@/lib/api/project-keys'

export const dynamic = 'force-dynamic'

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  project: z.string().optional(),
  type: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Which stores to search. Defaults to all of them — an agent asking whether
   * something has been debugged does not know, and should not have to guess,
   * whether the answer was written as a task, a note, a piece of knowledge or
   * the tail of a session.
   */
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : undefined)),
  tasksOnly: z.coerce.boolean().default(false),
})

/**
 * Rough token cost of expanding a row, advertised so the caller can decide
 * whether it is worth fetching. Approximate on purpose — the point is
 * order-of-magnitude budgeting, not accuracy.
 */
const estimateTokens = (...parts: (string | null | undefined)[]) =>
  Math.ceil(parts.filter(Boolean).join(' ').length / 4)

/**
 * The read half of Cairn-as-memory. An agent asks "has this already been done
 * or debugged?" before starting, and gets back an INDEX — ids, one-liners, and
 * what each costs to open. Never bodies: returning those in bulk is exactly the
 * waste that makes 61% of large reads never get looked at again.
 *
 * Closed tasks are included on purpose, and ones carrying a resolution rank
 * above ones that do not, because a recorded answer is the most valuable thing
 * the system holds.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = searchQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) {
      return fail('validation_failed', 'Provide ?q=<subject>.', { issues: parsed.error.issues })
    }
    const { q, type, status, limit, kinds, tasksOnly } = parsed.data
    // `--project AC` searches the project AC became. Matched as a string it
    // filtered on a key no row carries any more, and "nothing found — this
    // subject looks new" is the most misleading thing check can say.
    const { key: project, renamed } = await liveProjectKey(parsed.data.project)
    const told = renamed ? { renamed_from: renamed } : {}

    // A type or status filter is a statement about tasks, so it selects the
    // task-only path rather than being silently ignored on the others.
    const taskPath = tasksOnly || Boolean(type) || Boolean(status) || kinds?.join() === 'task'

    try {
      if (taskPath) {
        const { rows, widened } = await searchTasks(actor.userId, q, { project, type, status }, limit)
        const results = rows.map(taskResult)
        await recordSearch(actor, q, ['task'], rows.length, widened, results.map((r) => r.ref))
        return ok({ count: rows.length, query: q, widened, results, ...told })
      }

      const { rows, widened } = await searchAll(actor.userId, q, { project, kinds }, limit)

      const results = rows.map(unifiedResult)
      // The refs exactly as the caller was handed them, in rank order. Recorded
      // from the mapped results rather than the raw rows so what is stored is
      // what the agent saw — an event nobody can replay measures nothing.
      await recordSearch(actor, q, kinds ?? null, rows.length, widened, results.map((r) => r.ref))
      await markStaleKnowledge(actor.userId, results)
      return ok({ count: rows.length, query: q, widened, results, ...told })
    } catch (error) {
      return fail('internal_error', error instanceof Error ? error.message : 'Search failed.')
    }
  },
})

/**
 * Marks knowledge rows whose files have moved since the fact was confirmed.
 *
 * Done here rather than in `search_all` because staleness is a judgement about
 * evidence held in another table, and burying it in the ranking SQL would make
 * it neither testable nor arguable. Mutates in place: the ordering is the
 * database's and must not be rebuilt.
 */
const markStaleKnowledge = async (
  userId: string,
  results: ReturnType<typeof unifiedResult>[],
) => {
  const slugs = results.filter((r) => r.kind === 'knowledge').map((r) => r.ref)
  if (slugs.length === 0) return

  const { data } = await admin()
    .from('knowledge')
    .select('id, slug, body, verified_at, created_at, source_task_id, source_session_id, source_session_ref')
    .in('slug', slugs)

  const entries = (data ?? []) as {
    id: string
    slug: string
    body: string
    verified_at: string | null
    created_at: string | null
    source_task_id: string | null
    source_session_id: string | null
    source_session_ref: string | null
  }[]
  if (entries.length === 0) return

  const staleness = await stalenessFor(userId, entries)
  const bySlug = new Map(entries.map((e) => [e.slug, staleness.get(e.id)]))
  for (const row of results) {
    if (row.kind !== 'knowledge') continue
    row.stale = Boolean(bySlug.get(row.ref)?.stale)
    // Apart from `stale`: no files, so no evidence of change, only of age.
    row.unverified_days = bySlug.get(row.ref)?.unverifiedDays ?? null
  }
}

// Rows arrive ranked by the database. Do NOT re-sort them here: ordering by
// anything other than ts_rank discards relevance, which is exactly the
// regression 004 measured and 007 restored.
const taskResult = (row: SearchRow) => ({
  kind: 'task' as const,
  // ALWAYS the Cairn ref: it is what `cairn show` resolves. Returning the
  // imported identifier here hands the caller something that looks like a ref
  // and 404s, because no project has key "LEGACY".
  ref: `${row.project_key}-${row.number}`,
  // The original identifier, for recognising old work. Not addressable.
  externalRef: row.external_ref,
  title: row.title,
  type: row.type,
  status: row.status,
  resolved: Boolean(row.resolution),
  resolutionKind: row.resolution_kind,
  claimedBy: row.claimed_by,
  updatedAt: row.updated_at,
  // Widened hits matched loosely; say so rather than implying precision.
  loose: row.widened,
  tokens: estimateTokens(row.description, row.resolution),
  ...(row.renamed_from ? { requestedRef: row.requested_ref, renamedFrom: row.renamed_from } : {}),
})

const unifiedResult = (row: SearchAllRow) => ({
  kind: row.kind,
  ref: row.ref,
  title: row.title,
  subtitle: row.subtitle,
  project: row.project_key,
  type: row.type,
  status: row.status,
  // For a task this is a recorded resolution; for a note, that it is a finding
  // or a decision rather than an attempt; for knowledge, that it was verified.
  // In every case: this row is likelier to contain an answer.
  resolved: row.answered,
  updatedAt: row.updated_at,
  loose: row.widened,
  tokens: Math.ceil(row.body_bytes / 4),
  /**
   * Knowledge only: the files this fact names have been reworked by several
   * sessions since it was last confirmed. A mark, never a filter — a wrong
   * confidence signal is worse than none, so it is the reader who decides.
   */
  stale: false,
  unverified_days: null as number | null,
  // The exact-ref row only, when the ref went through a retired key.
  ...(row.renamed_from ? { requestedRef: row.requested_ref, renamedFrom: row.renamed_from } : {}),
})
