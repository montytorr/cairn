import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { buildContext, ContextProjectNotFoundError, ContextScopeError } from '@/lib/api/context'

export const dynamic = 'force-dynamic'

const contextQuery = z.object({
  cwd: z.string().max(500).optional(),
  project: z.string().max(10).optional(),
  file: z.string().max(500).optional(),
  // The origin remote, unnormalised: the rule for reducing spellings to one
  // repository lives on the server, so every caller reaches the same row.
  repo: z.string().max(500).optional(),
  scope: z.enum(['all', 'project']).optional(),
})

/**
 * The session-start briefing, and the file-open briefing, from one endpoint.
 *
 * Both answer the same question — "what should I know before I touch this" —
 * and both are read by a hook that has milliseconds and no way to recover from
 * a failure, so this route must stay cheap and must never be the reason a
 * session does not start.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = contextQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad query.', { issues: parsed.error.issues })

    try {
      return ok(await buildContext(actor, parsed.data))
    } catch (error) {
      if (error instanceof ContextProjectNotFoundError) return fail('not_found', error.message)
      if (error instanceof ContextScopeError) return fail('validation_failed', error.message)
      throw error
    }
  },
})
