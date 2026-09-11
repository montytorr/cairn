import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const checkpointBody = z.object({
  summary: z.string().min(1).max(10_000),
  payload: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Records where work stopped, so a different agent can resume without
 * reading anybody's transcript.
 *
 * Only the latest checkpoint is kept — it is the resume payload, and
 * checkpoint history is not this system's job. Beating the heartbeat here
 * too, since writing a checkpoint is proof of life.
 */
export const POST = route<{ ref: string }, z.infer<typeof checkpointBody>>({
  schema: checkpointBody,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const now = new Date().toISOString()
    const { data, error } = await admin()
      .from('tasks')
      .update({
        checkpoint_summary: body.summary,
        checkpoint_payload: body.payload ?? null,
        checkpoint_at: now,
        heartbeat_at: task.claimed_by === actor.actorId ? now : (task.heartbeat_at as string | null),
      })
      .eq('id', task.id)
      .select('id, number, checkpoint_summary, checkpoint_at')
      .single()

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})
