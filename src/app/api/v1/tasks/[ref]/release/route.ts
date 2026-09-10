import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/**
 * Drops a claim without closing the task. This is the whole of "handoff" —
 * release, having left a checkpoint. No contract, no invitation, no accept.
 */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('tasks')
      .update({ claimed_by: null, claimed_at: null, heartbeat_at: null })
      .eq('id', task.id)
      .select('id, number, status, claimed_by')
      .single()

    if (error) return fail('internal_error', error.message)

    await admin().from('task_activity_events').insert({
      task_id: task.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: 'released',
      data: { previousHolder: task.claimed_by },
    })

    return ok(data)
  },
})
