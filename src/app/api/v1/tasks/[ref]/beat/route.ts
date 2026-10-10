import { withLabField } from '@/lib/api/task-lab-fields'
import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, refuseArchived, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/** Keeps a claim alive. Only the holder may beat it. */
const beatBody = z.object({ ownershipVersion: z.number().int().nonnegative().optional() })

export const POST = route<{ ref: string }, z.infer<typeof beatBody>>({
  schema: beatBody,
  handler: async ({ actor, params, body, req }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const holder = task.claimed_by as string | null
    if (!holder) return fail('conflict', 'Task is not claimed — claim it first.')
    if (holder !== actor.actorId) {
      return fail('already_claimed', `Held by ${holder}, not you.`, { claimedBy: holder })
    }

    if (req.headers.get('idempotency-key') && body.ownershipVersion === undefined) {
      return fail('conflict', 'Queued heartbeat has no ownership generation; replay refused.')
    }

    let update = admin()
      .from('tasks')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('claimed_by', holder)
    if (body.ownershipVersion !== undefined) update = update.eq('ownership_version', body.ownershipVersion)
    const { data, error } = await update.select('id, number, claimed_by, heartbeat_at, ownership_version').maybeSingle()

    if (error) return fail('internal_error', error.message)
    if (!data) return fail('conflict', 'Claim ownership changed; stale heartbeat refused.')
    return ok(data && typeof data === 'object' ? await withLabField(data) : data)
  },
})
