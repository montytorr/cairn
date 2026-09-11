import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { createKnowledge, listKnowledge } from '@/lib/api/knowledge'
import { knowledgeCreate } from '@/schemas/knowledge'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  project: z.string().max(10).optional(),
  label: z.string().max(40).optional(),
  superseded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Knowledge scoped to a project deliberately includes the global rows: the
 * question is "what do we know that applies here", and an infra gotcha applies
 * here.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad filters.', { issues: parsed.error.issues })

    const { project, label, superseded, limit } = parsed.data
    const rows = await listKnowledge(actor.userId, {
      project,
      label,
      limit,
      includeSuperseded: superseded,
    })

    return ok({
      count: rows.length,
      results: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        labels: r.labels,
        projects: r.projects ?? [],
        scope: (r.projects ?? []).length === 0 ? 'global' : 'project',
        verified: Boolean(r.verified_at),
        superseded: Boolean(r.superseded_by),
        updatedAt: r.updated_at,
        tokens: Math.ceil((r.body?.length ?? 0) / 4),
      })),
    })
  },
})

export const POST = route({
  schema: knowledgeCreate,
  handler: async ({ actor, body }) => {
    try {
      const row = await createKnowledge(actor, body)
      return ok(row, { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not record that.'
      const code = message.includes('already exists') ? 'conflict' : 'validation_failed'
      return fail(code, message)
    }
  },
})
