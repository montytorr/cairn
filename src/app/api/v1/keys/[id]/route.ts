import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/** Revokes rather than deletes, so `last_used_at` history survives an incident. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const { data, error } = await admin()
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', params.id)
      .eq('user_id', actor.userId)
      .is('revoked_at', null)
      .select('id, agent_name, revoked_at')
      .maybeSingle()

    if (error) return fail('internal_error', error.message)
    if (!data) return fail('not_found', 'No such active key.')
    return ok(data)
  },
})
