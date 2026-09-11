import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const blockBody = z.object({
  /** Omit to unblock. */
  reason: z.string().min(1).max(2000).nullable().optional(),
})

/**
 * Two fields, deliberately. "Agent B is waiting on something" is the whole
 * signal; who owns the unblock, when it is due, and follow-up-versus-escalate
 * imply a hierarchy of accountable parties that does not exist here.
 */
export const POST = route<{ ref: string }, z.infer<typeof blockBody>>({
  schema: blockBody,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const blocking = Boolean(body.reason)
    const { data, error } = await admin()
      .from('tasks')
      .update({
        blocked_reason: body.reason ?? null,
        blocked_at: blocking ? new Date().toISOString() : null,
      })
      .eq('id', task.id)
      .select('id, number, status, blocked_reason, blocked_at')
      .single()

    if (error) return fail('internal_error', error.message)

    await admin().from('task_activity_events').insert({
      task_id: task.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: blocking ? 'blocked' : 'unblocked',
      data: { reason: body.reason ?? null },
    })

    return ok(data)
  },
})
