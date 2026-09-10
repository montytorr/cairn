import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { CLAIM_LEASE_SECONDS } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const claimBody = z.object({
  /** Defaults to the calling agent, which is almost always what you want. */
  agent: z.string().min(1).max(60).optional(),
  /** Move the task to `doing` at the same time. */
  setDoing: z.boolean().default(true),
})

/**
 * The entire coordination layer: one conditional UPDATE.
 *
 * It claims an unheld task, and steals a lease whose holder has stopped
 * beating for CLAIM_LEASE_SECONDS. Zero rows updated means somebody else
 * holds it — so contention is reported as a 409 rather than resolved by
 * guesswork. No reaper, no cron, no lease table.
 */
export const POST = route<{ ref: string }, z.infer<typeof claimBody>>({
  schema: claimBody,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const agent = body.agent ?? actor.actorId
    const now = new Date()
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_SECONDS * 1000).toISOString()

    const patch: Record<string, unknown> = {
      claimed_by: agent,
      claimed_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      attempt: ((task.attempt as number) ?? 0) + 1,
    }
    if (body.setDoing) patch.status = 'doing'

    const { data, error } = await admin()
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .or(`claimed_by.is.null,heartbeat_at.lt.${staleBefore}`)
      .select('id, number, status, claimed_by, claimed_at, heartbeat_at, attempt')

    if (error) return fail('internal_error', error.message)

    if (!data || data.length === 0) {
      const holder = task.claimed_by as string | null
      const lastBeat = task.heartbeat_at as string | null
      const agoMinutes = lastBeat
        ? Math.floor((now.getTime() - new Date(lastBeat).getTime()) / 60000)
        : null
      return fail(
        'already_claimed',
        `Held by ${holder}${agoMinutes !== null ? `, last heartbeat ${agoMinutes}m ago` : ''}. ` +
          `Pick different work; a lease becomes stealable after ${CLAIM_LEASE_SECONDS / 60}m of silence.`,
        { claimedBy: holder, heartbeatAt: lastBeat },
      )
    }

    await admin().from('task_activity_events').insert({
      task_id: task.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: 'claimed',
      data: { agent, attempt: patch.attempt },
    })

    return ok(data[0])
  },
})
