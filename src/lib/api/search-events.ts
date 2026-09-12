import { admin } from '@/lib/db/client'
import type { Actor } from './auth'

/**
 * Records that the memory was asked something.
 *
 * Deliberately best-effort. A search that cannot be logged must still be a
 * search that worked: measuring the thing is never worth breaking it, and this
 * sits on the hottest read in the product.
 *
 * Awaited rather than fired and forgotten — a promise left dangling in a
 * serverless handler may never flush — but the insert is one row against an
 * indexed table and the failure path costs nothing.
 */
export const recordSearch = async (
  actor: Actor,
  query: string,
  kinds: string[] | null,
  resultCount: number,
  /**
   * The precise query matched nothing and the search fell back to an OR of the
   * terms. This, not an empty result, is what "the memory did not have it"
   * looks like — two-pass search practically never returns zero rows.
   */
  widened: boolean,
) => {
  try {
    await admin().from('search_events').insert({
      owner_user_id: actor.userId,
      actor_id: actor.actorId ?? 'unknown',
      query: query.slice(0, 500),
      kinds,
      result_count: resultCount,
      widened,
    })
  } catch {
    // Nothing to do about it, and nothing worth failing the search over.
  }
}
