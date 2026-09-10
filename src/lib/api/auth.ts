import { admin } from '@/lib/supabase/admin'
import { serverClient } from '@/lib/supabase/server'
import { hashApiKey, hashesMatch, looksLikeApiKey } from './keys'

/**
 * Who is making a request.
 *
 * `userId` is the owner every query must be scoped to. `actorType`/`actorId`
 * are what get stamped on writes, so the shared memory records which of
 * Claude Code, Codex or OpenClaw did a thing — that attribution is most of
 * what makes the work log worth reading.
 */
export type Actor = {
  userId: string
  actorType: 'human' | 'agent'
  actorId: string
  /** Identity used for rate limiting: the key id, or the user for UI sessions. */
  rateKey: string
}

const bearerToken = (req: Request): string | null => {
  const header = req.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

/**
 * Agents authenticate with a bearer API key; the human UI authenticates with
 * its Supabase session cookie. Deliberately not HMAC request signing: with a
 * single owner and no untrusted callers, signing buys nothing and costs every
 * caller a canonicalisation and nonce implementation.
 */
export const authenticate = async (req: Request): Promise<Actor | null> => {
  const token = bearerToken(req)

  if (token && looksLikeApiKey(token)) {
    const { data, error } = await admin()
      .from('api_keys')
      .select('id, user_id, agent_name, key_hash, revoked_at')
      .eq('key_hash', hashApiKey(token))
      .is('revoked_at', null)
      .maybeSingle()

    if (error || !data) return null
    if (!hashesMatch(data.key_hash, hashApiKey(token))) return null

    // Best-effort; a failed touch must never fail the request.
    //
    // NOTE: this must be `.then(...)`, not `void <builder>`. A Supabase query
    // builder is a lazy thenable — it does not issue the request until
    // something subscribes to it. `void builder` type-checks, looks like
    // fire-and-forget, and silently never runs. It meant last_used_at stayed
    // null for every key despite constant use, which was only noticed once
    // the settings UI put that column on screen.
    admin()
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(
        () => undefined,
        () => undefined, // never let a failed touch fail the request
      )

    return {
      userId: data.user_id,
      actorType: 'agent',
      actorId: data.agent_name,
      rateKey: `key:${data.id}`,
    }
  }

  const supabase = await serverClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return null

  return {
    userId: data.user.id,
    actorType: 'human',
    // The email, not the uuid. `actorId` is stamped on every write and shown
    // in the activity trail as "who changed this" — a uuid there answers
    // nothing, and an agent's actorId is already its readable name.
    actorId: data.user.email ?? data.user.id,
    rateKey: `user:${data.user.id}`,
  }
}
