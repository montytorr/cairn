import { route } from '@/lib/api/handler'
import { recordActivity } from '@/lib/api/activity'
import { ok, fail } from '@/lib/api/response'
import { deleteKnowledge, getKnowledge, updateKnowledge } from '@/lib/api/knowledge'
import {
  checkReferences,
  deletionRefusal,
  liveReferrers,
  referenceCorpus,
  referenceRefusal,
  referenceWarnings,
} from '@/lib/api/knowledge-graph'
import { recordKnowledgeRead } from '@/lib/api/search-events'
import { knowledgeUpdate } from '@/schemas/knowledge'

export const dynamic = 'force-dynamic'

type Params = { slug: string }

/**
 * Whether a read says it is part of a sweep (`X-Cairn-Read: sweep`, sent by
 * `cairn know --sweep` or CAIRN_SWEEP=1). The database also tags bursts by
 * rate (064), because the audit loops that inflated recall never said so.
 */
const isSweepRead = (req: Request): boolean =>
  req.headers.get('x-cairn-read')?.trim().toLowerCase() === 'sweep'

/**
 * Direct recall: the agent already knows what it wants and asks for it by name.
 *
 * Instrumented because this is the single path that answers "do agents call
 * knowledge when they need it", and it recorded nothing — `recordSearch` only
 * ever fired from /api/v1/search, so every `cairn know <slug>` and every
 * browser read was invisible.
 *
 * The miss is recorded as deliberately as the hit. A 404 here is an agent
 * following a reference to a fact it expected to exist, so a miss is a
 * dangling reference (CAIRN-253) caught in the act instead of reconstructed
 * from the corpus afterwards. Absence of a row would say nothing at all.
 */
export const GET = route<Params>({
  handler: async ({ actor, params, req }) => {
    const row = await getKnowledge(actor.userId, params.slug)
    await recordKnowledgeRead(actor, params.slug, Boolean(row), { sweep: isSweepRead(req) })
    if (!row) return fail('not_found', `No knowledge "${params.slug}".`)
    return ok(row)
  },
})

/**
 * An edit resolves its references for the same reason a write does.
 *
 * POST checked and PATCH did not, which leaves the whole point reachable in one
 * hop: write a clean entry, then edit a dangling `[[ref]]` into it with nothing
 * looking. A body that is not being changed is not re-checked — a rename or a
 * `--verified` should not fail on a reference the entry has carried for weeks.
 *
 * And a body that IS being changed is checked only for what the change adds
 * (CAIRN-347). The sentence above was the intent, but the code checked every
 * reference whenever a body was sent at all — and the web editor always sends
 * one, so fixing a typo in one paragraph was refused over a `[[ref]]` in
 * another that predates the check. A reference already in the stored body is
 * passed through; a new one is checked exactly as POST checks it, so the
 * one-hop route stays closed.
 */
export const PATCH = route<Params, unknown>({
  schema: knowledgeUpdate,
  secretFields: ['title', 'body', 'reason'],
  handler: async ({ actor, params, body }) => {
    const patch = body as { body?: string; allowUnresolvedRefs?: boolean }
    let warnings: string[] = []
    if (patch.body?.includes('[[')) {
      const [stored, corpus] = await Promise.all([
        getKnowledge(actor.userId, params.slug),
        referenceCorpus(),
      ])
      const report = checkReferences({
        body: patch.body,
        slug: params.slug,
        previous: stored?.body ?? null,
        ...corpus,
      })
      const refusal = referenceRefusal(report, { allowUnresolved: patch.allowUnresolvedRefs })
      if (refusal) {
        return fail('validation_failed', refusal, {
          unresolvedReferences: report.unresolved,
          taskReferences: report.taskShaped.map((ref) => ref.raw),
        })
      }
      warnings = referenceWarnings(report)
    }

    try {
      const row = await updateKnowledge(actor, params.slug, body as never)
      if (!row) return fail('not_found', `No knowledge "${params.slug}".`)
      return ok(warnings.length > 0 ? { ...row, warnings } : row)
    } catch (error) {
      return fail('validation_failed', error instanceof Error ? error.message : 'Update failed.')
    }
  },
})

/**
 * `?allowUnresolvedRefs=true`: delete it even though live entries reference it.
 *
 * A query parameter, not a body, because a DELETE body is something proxies
 * and fetch implementations are entitled to drop — and an override that can
 * silently vanish turns into a refusal nobody can get past.
 */
const allowsDangling = (url: URL): boolean =>
  ['1', 'true'].includes(url.searchParams.get('allowUnresolvedRefs')?.trim().toLowerCase() ?? '')

export const DELETE = route<Params>({
  handler: async ({ actor, params, url }) => {
    // Read before removing: the activity feed builds its knowledge rows from
    // the live table, so a deleted fact vanishes from the timeline as though
    // it had never been written. The title is the only part worth keeping and
    // it is unreadable a line later.
    const doomed = await getKnowledge(actor.userId, params.slug)

    // A hard delete of an entry others point at turns every one of those
    // `[[refs]]` into a reference to nothing, at once and in silence — the
    // write path refuses to create ONE such reference, so this refuses to
    // create many (CAIRN-347). Superseding is the answer it points to: the
    // page stays, the references still land, and it says where to go next.
    if (doomed && !allowsDangling(url)) {
      const referrers = await liveReferrers(doomed.slug)
      const refusal = deletionRefusal(doomed.slug, referrers)
      if (refusal) {
        return fail('conflict', refusal, {
          referrers: referrers.slice(0, 20),
          referrerCount: referrers.length,
        })
      }
    }

    const gone = await deleteKnowledge(actor.userId, params.slug)
    if (!gone) return fail('not_found', `No knowledge "${params.slug}".`)

    await recordActivity([
      {
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'knowledge_deleted',
        data: { slug: params.slug, title: doomed?.title?.slice(0, 200) ?? null },
      },
    ], actor.userId, actor.host)

    return ok({ deleted: params.slug })
  },
})
