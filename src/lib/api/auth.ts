import { pool } from '@/lib/db/client'
import { sessionUser } from '@/lib/auth/session'
import { actorLabel, type UserRole } from './actor'
import { hashApiKey, hashesMatch, looksLikeApiKey } from './keys'

/**
 * Who is making a request.
 *
 * `userId` identifies the human behind the request. Workspace data is shared;
 * `actorType`/`actorId` are what get stamped on writes, so the shared memory records which of
 * Claude Code, Codex or OpenClaw did a thing — that attribution is most of
 * what makes the work log worth reading.
 */
export type Actor = {
  userId: string
  actorType: 'human' | 'agent'
  actorId: string
  userDisplayName: string
  role: UserRole
  /** Identity used for rate limiting: the key id, or the user for UI sessions. */
  rateKey: string
  /**
   * Which session is making this request, when the caller can say.
   *
   * `actorId` names a runtime and a human — `claude-code · cal@example.com` —
   * and four Claude Code sessions on one machine all write that same string.
   * It is an identity, not a worker. This is the worker, and it is optional
   * because Codex and OpenClaw may not have one to give.
   */
  sessionId: string | null
  /**
   * The API key's bare agent name (`claude-code`, `maintenance`), for agents.
   *
   * `actorId` embeds it, but it also embeds a display name anyone can set, so
   * anything that grants a power by agent name reads it from here — straight
   * from the key row, which only an administrator can create.
   */
  agentName?: string
   * Which machine the caller says it is on, when it says (CAIRN-290).
   *
   * Key names are per runtime, not per machine, so a laptop and a server
   * write the same `actorId` and a misattributed write cannot be traced to
   * the box that made it. `actorId` is left alone — it is the join key for
   * the whole history — and the host is recorded beside it wherever a row
   * already has a jsonb column for it. Self-reported, so it is a diagnostic,
   * never an authorization input.
   */
  host?: string | null
}

/**
 * The caller's session, if it named one.
 *
 * A header rather than a body field, so it arrives on every request without
 * every endpoint growing a parameter for it. Bounded and filtered because it
 * is stored and displayed: anything unexpected is dropped rather than
 * sanitised, since a session id we cannot trust is no better than none.
 */
const sessionOf = (req: Request): string | null => {
  const raw = req.headers.get('x-cairn-session')?.trim()
  if (!raw || raw.length > 100) return null
  return /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : null
}

/** Same filter as the session id, for the same reason: it is stored and shown. */
export const hostOf = (req: Request): string | null => {
  const raw = req.headers.get('x-cairn-host')?.trim()
  if (!raw || raw.length > 100) return null
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null
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
 * its application session cookie. Deliberately not HMAC request signing: TLS,
 * opaque revocable credentials and server-side authorization provide the
 * boundary without making every caller implement canonicalisation and nonces.
 */
export const authenticate = async (req: Request): Promise<Actor | null> => {
  const token = bearerToken(req)

  if (token && looksLikeApiKey(token)) {
    const tokenHash = hashApiKey(token)
    const { rows } = await pool().query<{
      id: string
      user_id: string
      agent_name: string
      key_hash: string
      role: UserRole
      user_display_name: string
    }>(
      `select k.id, k.user_id, k.agent_name, k.key_hash, u.role,
              coalesce(nullif(trim(p.display_name), ''), u.email) as user_display_name
         from api_keys k
         join app_users u on u.id = k.user_id
         left join user_profiles p on p.id = u.id
        where k.key_hash = $1 and k.revoked_at is null
          and k.auth_epoch = u.auth_epoch
          and u.deleted_at is null
          and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
        limit 1`,
      [tokenHash],
    )
    const data = rows[0]
    if (!data || !hashesMatch(data.key_hash, tokenHash)) return null

    // Best-effort; a failed touch must never fail the request.
    //
    // NOTE: this must be `.then(...)`, not `void <builder>`. The query
    // builder is a lazy thenable — it does not issue the request until
    // something subscribes to it. `void builder` type-checks, looks like
    // fire-and-forget, and silently never runs. It meant last_used_at stayed
    // null for every key despite constant use, which was only noticed once
    // the settings UI put that column on screen.
    pool()
      .query('update api_keys set last_used_at = now() where id = $1', [data.id])
      .then(
        () => undefined,
        () => undefined, // never let a failed touch fail the request
      )

    return {
      userId: data.user_id,
      actorType: 'agent',
      actorId: actorLabel('agent', data.agent_name, data.user_display_name),
      userDisplayName: data.user_display_name,
      role: data.role,
      rateKey: `key:${data.id}`,
      sessionId: sessionOf(req),
      agentName: data.agent_name,
      host: hostOf(req),
    }
  }

  const user = await sessionUser()
  if (!user) return null

  return {
    userId: user.id,
    actorType: 'human',
    // Use the canonical display identity. `actorId` is stamped on every write
    // and shown in the activity trail, where a UUID answers nothing.
    actorId: actorLabel('human', user.email ?? user.id, user.displayName),
    userDisplayName: user.displayName,
    role: user.role,
    rateKey: `user:${user.id}`,
    // A browser has no session id to give, and should not: the person at the
    // keyboard is the same worker whichever tab they are in.
    sessionId: null,
  }
}
