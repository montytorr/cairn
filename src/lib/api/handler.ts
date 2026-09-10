import { ZodError, type ZodType } from 'zod'
import { authenticate, type Actor } from './auth'
import { checkRateLimit } from './rate-limit'
import { fail, failValidation } from './response'

type Ctx<P, B> = { actor: Actor; params: P; body: B; req: Request; url: URL }

type Config<P, B> = {
  schema?: ZodType<B>
  handler: (ctx: Ctx<P, B>) => Promise<Response>
}

/**
 * Wraps a route handler with authentication, rate limiting, body parsing and
 * validation, so individual routes stay small.
 *
 * a2a-comms is the cautionary tale here: its task POST grew to 713 lines and
 * its PATCH to 1,205, because trust gates, contract proposal, webhook delivery
 * and email all landed inline. Business logic belongs in lib/, routes stay thin.
 */
export const route = <P = Record<string, string>, B = unknown>(config: Config<P, B>) => {
  return async (req: Request, context: { params: Promise<P> }): Promise<Response> => {
    try {
      const actor = await authenticate(req)
      if (!actor) {
        return fail('unauthorized', 'Provide a bearer API key or sign in.')
      }

      const limit = checkRateLimit(actor.rateKey)
      if (!limit.allowed) {
        return fail('rate_limited', `Too many requests. Retry in ${limit.retryAfter}s.`, {
          retryAfter: limit.retryAfter,
        })
      }

      let body = {} as B
      if (req.method !== 'GET' && req.method !== 'DELETE' && config.schema) {
        const raw = await req.json().catch(() => ({}))
        const parsed = config.schema.safeParse(raw)
        if (!parsed.success) return failValidation(parsed.error.issues)
        body = parsed.data
      }

      const params = (await context.params) ?? ({} as P)
      return await config.handler({ actor, params, body, req, url: new URL(req.url) })
    } catch (error) {
      if (error instanceof ZodError) return failValidation(error.issues)
      console.error('[api] unhandled', error)
      return fail('internal_error', 'Something went wrong.')
    }
  }
}
