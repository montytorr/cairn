import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { listSessions, upsertSession } from '@/lib/api/sessions'
import { sessionUpsert } from '@/schemas/session'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  project: z.string().max(10).optional(),
  cwd: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad filters.', { issues: parsed.error.issues })

    const rows = await listSessions(actor.userId, parsed.data)
    return ok({
      count: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        platform: r.platform_source,
        agent: r.agent_id,
        cwd: r.cwd,
        endedAt: r.ended_at,
        request: r.request,
        nextSteps: r.next_steps,
        files: (r.files ?? []).length,
        taskRefs: r.task_refs ?? [],
      })),
    })
  },
})

/**
 * Idempotent on (platform, externalId). Codex has no session-end event so its
 * writer runs on Stop, which fires every turn; OpenClaw's runs from a
 * reconciler that may sweep a session a hook already recorded. Both must be
 * able to post repeatedly without producing a second row.
 */
export const POST = route({
  schema: sessionUpsert,
  handler: async ({ actor, body }) => {
    try {
      const { session, checkpointed } = await upsertSession(actor, body)
      return ok({ id: session.id, endedAt: session.ended_at, checkpointed })
    } catch (error) {
      return fail('validation_failed', error instanceof Error ? error.message : 'Could not record.')
    }
  },
})
