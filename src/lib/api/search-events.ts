import { admin } from '@/lib/db/client'
import { normalizeSlugRef } from '@/schemas/knowledge'
import type { Actor } from './auth'

/**
 * How many refs are worth keeping per search event.
 *
 * The search limit is capped at 100, and the question this column answers —
 * "was the right entry in what came back, and where" — is answered by the head
 * of the list. Storing the tail would grow the table without adding a reading.
 */
const MAX_RETURNED_SLUGS = 50

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
  /**
   * The addressable ref of each row returned, in rank order.
   *
   * Without this only the COUNT was stored, so "did the search return the right
   * fact" was unanswerable in principle: a widened search that found the right
   * entry and a precise one that found the wrong entry are the same row. The
   * refs are what `cairn show` and `cairn know` take, so a stored event can be
   * replayed against the corpus rather than merely counted.
   */
  returnedSlugs: string[],
) => {
  try {
    await admin().from('search_events').insert({
      owner_user_id: actor.userId,
      actor_id: actor.actorId ?? 'unknown',
      query: query.slice(0, 500),
      kinds,
      result_count: resultCount,
      widened,
      returned_slugs: returnedSlugs.slice(0, MAX_RETURNED_SLUGS).map((ref) => ref.slice(0, 200)),
    })
  } catch {
    // Nothing to do about it, and nothing worth failing the search over.
  }
}

/**
 * Records that a named fact was recalled directly — `cairn know <slug>`, the
 * knowledge page, anything that addresses an entry rather than searching for
 * one.
 *
 * This is the path that most directly answers "do agents call knowledge when
 * they need it", and until now it was the only read path with no record of
 * having happened at all.
 *
 * A MISS is the row worth having. An agent asking for a slug believed that
 * fact existed — usually because something in the corpus referenced it — so a
 * miss is a dangling reference being followed at the moment it fails, rather
 * than one found later by crawling the text. It is therefore recorded, not
 * merely absent.
 *
 * Kept out of `search_events` on purpose. `widened` is meaningless here, and
 * `result_count = 0` means the opposite of what it means for a search: for a
 * two-pass search an empty result is noise, for a slug lookup it is the whole
 * signal. See migration 053.
 *
 * Best-effort for the same reason as recordSearch: a read that cannot be
 * logged must still be a read that worked.
 */
export const recordKnowledgeRead = async (
  actor: Actor,
  slug: string,
  hit: boolean,
  { sweep = false }: { sweep?: boolean } = {},
) => {
  try {
    await admin().from('knowledge_reads').insert({
      owner_user_id: actor.userId,
      actor_id: actor.actorId ?? 'unknown',
      // Normalised the way the lookup itself normalises it, so `[[a_b_c]]` and
      // `a-b-c` are one slug in the telemetry as they are one slug in the
      // table. A miss is only useful if it joins.
      slug: normalizeSlugRef(slug).slice(0, 200),
      hit,
      // Kept, not dropped: a sweep is still a read, it is just not a recall.
      ...(sweep ? { sweep: true } : {}),
    })
  } catch {
    // Nothing to do about it, and nothing worth failing the read over.
  }
}
