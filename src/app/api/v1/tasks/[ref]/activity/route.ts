import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/**
 * The audit trail. `task_activity_events` has been written since the first
 * migration and, until now, read by nothing at all — the data accumulated
 * invisibly for the entire life of the system.
 *
 * Distinct from `/notes`, which is what an agent chose to say. This is what
 * actually happened, whether anyone narrated it or not.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)

    const { data, error } = await admin()
      .from('task_activity_events')
      .select('id, event, data, actor_type, actor_id, created_at')
      .eq('task_id', task.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) return fail('internal_error', error.message)
    return ok(data ?? [])
  },
})
