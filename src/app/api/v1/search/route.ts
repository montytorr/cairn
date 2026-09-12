import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { searchAll, searchTasks, type SearchAllRow, type SearchRow } from '@/lib/api/search'
import { recordSearch } from '@/lib/api/search-events'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

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
    const { q, project, type, status, limit, kinds, tasksOnly } = parsed.data

    // A type or status filter is a statement about tasks, so it selects the
    // task-only path rather than being silently ignored on the others.
    const taskPath = tasksOnly || Boolean(type) || Boolean(status) || kinds?.join() === 'task'

    try {
      if (taskPath) {
        const { rows, widened } = await searchTasks(actor.userId, q, { project, type, status }, limit)
        await recordSearch(actor, q, ['task'], rows.length, widened)
        return ok({ count: rows.length, query: q, widened, results: rows.map(taskResult) })
      }

      const { rows, widened } = await searchAll(actor.userId, q, { project, kinds }, limit)
      await recordSearch(actor, q, kinds ?? null, rows.length, widened)
      return ok({ count: rows.length, query: q, widened, results: rows.map(unifiedResult) })
    } catch (error) {
      return fail('internal_error', error instanceof Error ? error.message : 'Search failed.')
    }
  },
})

// Rows arrive ranked by the database. Do NOT re-sort them here: ordering by
// anything other than ts_rank discards relevance, which is exactly the
// regression 004 measured and 007 restored.
const taskResult = (row: SearchRow) => ({
  kind: 'task' as const,
  // ALWAYS the Cairn ref: it is what `cairn show` resolves. Returning the
  // imported identifier here hands the caller something that looks like a ref
  // and 404s, because no project has key "BBTRADE".
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
})
