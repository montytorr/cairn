import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { generateApiKey } from '@/lib/api/keys'

export const dynamic = 'force-dynamic'

const createKey = z.object({
  agentName: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes, e.g. claude-code'),
  name: z.string().min(1).max(100),
})

export const GET = route({
  handler: async ({ actor }) => {
    // key_hash is deliberately never selected.
    const { data, error } = await admin()
      .from('api_keys')
      .select('id, agent_name, name, key_prefix, last_used_at, revoked_at, created_at')
      .eq('user_id', actor.userId)
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})

/**
 * One key per agent, so writes are attributable and any single agent can be
 * revoked without disturbing the others. The plaintext is returned exactly
 * once, here, and never stored.
 */
export const POST = route<Record<string, string>, z.infer<typeof createKey>>({
  schema: createKey,
  handler: async ({ actor, body }) => {
    const { key, keyHash, keyPrefix } = generateApiKey()

    const { data, error } = await admin()
      .from('api_keys')
      .insert({
        user_id: actor.userId,
        agent_name: body.agentName,
        platform_source: body.agentName,
        name: body.name,
        key_prefix: keyPrefix,
        key_hash: keyHash,
      })
      .select('id, agent_name, name, key_prefix, created_at')
      .single()

    if (error) return fail('internal_error', error.message)

    return ok(
      {
        ...data,
        key,
        warning: 'This is the only time the key is shown. Store it now.',
      },
      { status: 201 },
    )
  },
})
