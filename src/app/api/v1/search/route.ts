import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

export const dynamic = 'force-dynamic'

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  project: z.string().optional(),
  type: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
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
    const { q, project, type, status, limit } = parsed.data

    let query = admin()
      .from('tasks')
      .select(
        'id, number, title, type, status, priority, resolution, resolution_kind, ' +
          'description, claimed_by, updated_at, project:projects!inner(key, owner_user_id)',
      )
      .eq('projects.owner_user_id', actor.userId)
      .textSearch('search_vector', q, { type: 'websearch', config: 'english' })

    if (project) query = query.eq('projects.key', project.toUpperCase())
    if (type) query = query.eq('type', type)
    if (status) query = query.eq('status', status)

    const { data, error } = await query.limit(limit)
    if (error) return fail('internal_error', error.message)

    type Row = Record<string, unknown> & { project: { key: string } | { key: string }[] }
    const results = (data as unknown as Row[]).map((row) => {
      const proj = Array.isArray(row.project) ? row.project[0] : row.project
      const resolution = row.resolution as string | null
      return {
        ref: `${proj?.key}-${row.number}`,
        title: row.title as string,
        type: row.type as string,
        status: row.status as string,
        // Flags which hits actually carry an answer.
        resolved: Boolean(resolution),
        resolutionKind: row.resolution_kind as string | null,
        claimedBy: row.claimed_by as string | null,
        updatedAt: row.updated_at as string,
        tokens: estimateTokens(row.description as string, resolution),
      }
    })

    // A hit with a written resolution answers the question; one without only
    // says somebody else has been here. Rank accordingly.
    results.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })

    return ok({ count: results.length, query: q, results })
  },
})
