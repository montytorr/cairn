import { route } from '@/lib/api/handler'
import { recordActivity } from '@/lib/api/activity'
import { ok, fail } from '@/lib/api/response'
import { deleteKnowledge, getKnowledge, updateKnowledge } from '@/lib/api/knowledge'
import { checkReferences, knownSlugs, referenceRefusal, referenceWarnings } from '@/lib/api/knowledge-graph'
import { recordKnowledgeRead } from '@/lib/api/search-events'
import { knowledgeUpdate } from '@/schemas/knowledge'

export const dynamic = 'force-dynamic'

type Params = { slug: string }

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
  handler: async ({ actor, params }) => {
    const row = await getKnowledge(actor.userId, params.slug)
    await recordKnowledgeRead(actor, params.slug, Boolean(row))
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
 */
export const PATCH = route<Params, unknown>({
  schema: knowledgeUpdate,
  handler: async ({ actor, params, body }) => {
    const patch = body as { body?: string; allowUnresolvedRefs?: boolean }
    let warnings: string[] = []
    if (patch.body?.includes('[[')) {
      const report = checkReferences({
        body: patch.body,
        slug: params.slug,
        known: await knownSlugs(),
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

export const DELETE = route<Params>({
  handler: async ({ actor, params }) => {
    // Read before removing: the activity feed builds its knowledge rows from
    // the live table, so a deleted fact vanishes from the timeline as though
    // it had never been written. The title is the only part worth keeping and
    // it is unreadable a line later.
    const doomed = await getKnowledge(actor.userId, params.slug)

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
