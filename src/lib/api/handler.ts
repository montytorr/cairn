import { ZodError, type ZodType } from 'zod'
import { authenticate, type Actor } from './auth'
import { checkRateLimit } from './rate-limit'
import { fail, failValidation } from './response'
import { findSecret, secretRefusal } from '@/lib/secrets'

type Ctx<P, B> = { actor: Actor; params: P; body: B; req: Request; url: URL }

type Config<P, B> = {
  schema?: ZodType<B>
  /**
   * Body fields that are stored and read back to other agents, checked for
   * secret-shaped strings after validation (CAIRN-285). One shared detector,
   * applied here so no write path can forget it.
   */
  secretFields?: readonly string[]
  handler: (ctx: Ctx<P, B>) => Promise<Response>
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** X-Forwarded-* is a comma-separated list; the first entry is the client's hop. */
const firstHop = (value: string | null): string | null => value?.split(',')[0]?.trim() || null

/**
 * The origin this deployment is actually served on.
 *
 * `req.url` alone is wrong behind a reverse proxy that terminates TLS — which
 * is the deployment the README documents. The proxy forwards a plaintext
 * request, so the URL reads `http://`, while the browser announces `https://`,
 * and the comparison below could never match: every browser write was refused
 * with "Browser mutations must come from the Cairn origin", including the first
 * agent key a fresh install has to issue.
 *
 * Trusting these headers assumes the application is reachable only through the
 * proxy — which the architecture already requires, since the container binds no
 * host port and sits on an internal network. A deployment that exposed the app
 * directly would let a client forge them, and would have larger problems.
 *
 * That assumption is narrower than it sounds, which is worth writing down
 * because it is the part a reader will worry about. The attack being kept out
 * is CSRF, and CSRF needs a browser to attach the victim's cookie. Neither
 * X-Forwarded header is CORS-safelisted, so a cross-origin page cannot set one
 * without a preflight, and this app sends no Access-Control-Allow-* header
 * anywhere, so that preflight is never approved. A client that can forge the
 * headers is not a browser, and so does not have the cookie the check exists
 * to protect. login/route.ts already keys its brute-force limiter on
 * X-Forwarded-For on the same reasoning, undocumented until now.
 */
const servedOrigin = (req: Request): string => {
  const url = new URL(req.url)
  const proto = firstHop(req.headers.get('x-forwarded-proto')) ?? url.protocol.replace(':', '')
  const host = firstHop(req.headers.get('x-forwarded-host')) ?? url.host
  // A browser's Origin is already a normal form: scheme and host lower-cased,
  // a default port omitted. A proxy's headers are not — nginx hands back the
  // Host verbatim, port and all — so compose through URL and compare normal
  // forms. Otherwise a correct deployment is refused over a `:443` nobody
  // typed, which is the same 403 with a harder cause to find.
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    // A header we cannot parse is a header we do not trust. Fall back to what
    // the request itself says, which is the behaviour before any of this: it
    // refuses rather than admits, and that is the right direction to fail.
    return url.origin
  }
}

/**
 * Browser sessions use cookies, so unsafe requests must prove they came from
 * this exact origin. Bearer callers are not vulnerable to ambient-cookie CSRF.
 */
export const isTrustedMutationOrigin = (req: Request): boolean => {
  if (SAFE_METHODS.has(req.method)) return true
  if (/^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '')) return true
  const origin = req.headers.get('origin')
  return origin !== null && origin === servedOrigin(req)
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
      if (!isTrustedMutationOrigin(req)) {
        return fail('forbidden', 'Browser mutations must come from the Cairn origin.')
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
        if (config.secretFields) {
          const hit = findSecret(body, config.secretFields)
          // The rule and where, never the value: echoing it would put the
          // secret in the response, the CLI's stderr and the transcript.
          if (hit) {
            return fail('secret_detected', secretRefusal(hit), {
              field: hit.field,
              pattern: hit.pattern,
              line: hit.line,
            })
          }
        }
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
