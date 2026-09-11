import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { deleteKnowledge, getKnowledge, updateKnowledge } from '@/lib/api/knowledge'
import { knowledgeUpdate } from '@/schemas/knowledge'

export const dynamic = 'force-dynamic'

type Params = { slug: string }

export const GET = route<Params>({
  handler: async ({ actor, params }) => {
    const row = await getKnowledge(actor.userId, params.slug)
    if (!row) return fail('not_found', `No knowledge "${params.slug}".`)
    return ok(row)
  },
})

export const PATCH = route<Params, unknown>({
  schema: knowledgeUpdate,
  handler: async ({ actor, params, body }) => {
    try {
      const row = await updateKnowledge(actor, params.slug, body as never)
      if (!row) return fail('not_found', `No knowledge "${params.slug}".`)
      return ok(row)
    } catch (error) {
      return fail('validation_failed', error instanceof Error ? error.message : 'Update failed.')
    }
  },
})

export const DELETE = route<Params>({
  handler: async ({ actor, params }) => {
    const gone = await deleteKnowledge(actor.userId, params.slug)
    if (!gone) return fail('not_found', `No knowledge "${params.slug}".`)
    return ok({ deleted: params.slug })
  },
})
