import { admin } from '@/lib/supabase/admin'

/**
 * Query construction for prior-work discovery.
 *
 * Postgres full-text search ANDs the terms of a websearch query, which is the
 * right default for precision: an agent searching "supavisor pool timeouts"
 * wants the task about exactly that. It is the wrong behaviour when the agent
 * words the subject differently from whoever filed it, which is most of the
 * time — and a zero-result search reads as "this is new", the single most
 * expensive wrong answer this system can give.
 *
 * So: try the precise query first, and widen only when it comes back thin.
 * Precision is preserved where it works, recall is recovered where it does not.
 */

/** Words too common to be worth ORing on; they would match half the corpus. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'why', 'how', 'are', 'was', 'were', 'not', '但', 'les', 'des', 'une', 'dans',
  'pour', 'avec', 'sur', 'est', 'sont', 'pas', 'que', 'qui',
])

export const distinctiveTerms = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ].slice(0, 8)

/** `a OR b OR c` — websearch_to_tsquery understands OR. */
export const widenedQuery = (query: string): string | null => {
  const terms = distinctiveTerms(query)
  return terms.length >= 2 ? terms.join(' OR ') : null
}

export type SearchRow = Record<string, unknown> & {
  number: number
  project: { key: string } | { key: string }[]
}

const SELECT =
  'id, number, title, type, status, priority, resolution, resolution_kind, ' +
  'description, claimed_by, updated_at, external_ref, ' +
  'project:projects!inner(key, owner_user_id)'

const run = async (
  userId: string,
  q: string,
  filters: { project?: string; type?: string; status?: string },
  limit: number,
) => {
  let query = admin()
    .from('tasks')
    .select(SELECT)
    .eq('projects.owner_user_id', userId)
    .textSearch('search_vector', q, { type: 'websearch', config: 'english' })

  if (filters.project) query = query.eq('projects.key', filters.project.toUpperCase())
  if (filters.type) query = query.eq('type', filters.type)
  if (filters.status) query = query.eq('status', filters.status)

  const { data, error } = await query.limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SearchRow[]
}

/**
 * Runs the precise query, then widens if it found little. `widened` is
 * reported back so the caller can say so rather than silently changing
 * the meaning of the search.
 */
export const searchTasks = async (
  userId: string,
  q: string,
  filters: { project?: string; type?: string; status?: string },
  limit: number,
): Promise<{ rows: SearchRow[]; widened: boolean }> => {
  const precise = await run(userId, q, filters, limit)

  // Three is a judgement call, not a measurement: enough that a confident
  // answer is probably in there, few enough that it is worth a second look.
  if (precise.length >= 3) return { rows: precise, widened: false }

  const wide = widenedQuery(q)
  if (!wide) return { rows: precise, widened: false }

  const widenedRows = await run(userId, wide, filters, limit * 2)

  // Precise matches keep their position at the top; widened ones fill in below.
  const seen = new Set(precise.map((r) => r.id as string))
  const merged = [...precise, ...widenedRows.filter((r) => !seen.has(r.id as string))]

  return { rows: merged.slice(0, limit), widened: merged.length > precise.length }
}
