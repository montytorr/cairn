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

/**
 * The distinctive terms, passed to the database as an array.
 *
 * The database needs the terms individually, not pre-joined: it ranks widened
 * results by how many DISTINCT terms a row matches, which cannot be recovered
 * from an already-ORed string.
 */
export const widenedTerms = (query: string): string[] | null => {
  const terms = distinctiveTerms(query)
  return terms.length >= 2 ? terms : null
}

export type SearchRow = {
  id: string
  number: number
  title: string
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  description: string | null
  claimed_by: string | null
  updated_at: string
  external_ref: string | null
  project_key: string
  rank: number
  coverage: number
  widened: boolean
}

/**
 * Ranking happens in Postgres, via the search_tasks function.
 *
 * ts_rank needs the tsvector and tsquery together, and PostgREST cannot order
 * by an expression it did not select — so ordering here would mean ordering by
 * something other than relevance. Doing exactly that (recency) dropped
 * measured recall from 75% to 6%: widening returns many more rows, and a
 * recency sort buries the exact match among them.
 */
export const searchTasks = async (
  userId: string,
  q: string,
  filters: { project?: string; type?: string; status?: string },
  limit: number,
): Promise<{ rows: SearchRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_tasks', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: filters.project ?? null,
    p_type: filters.type ?? null,
    p_status: filters.status ?? null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchRow[]
  return { rows, widened: rows.some((r) => r.widened) }
}
