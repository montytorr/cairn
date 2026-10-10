import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { refuseHandedOff } from '@/lib/api/lab-shape'
import { takeTask } from '@/lib/api/claim'
import { withAssignee } from '@/lib/api/people'
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
    const archived = refuseArchived(task)
    if (archived) return archived
    // Its tracker owns it while the hand-off is open (docs/lab.md).
    const handedOff = refuseHandedOff(task, refOfRow(task) ?? params.ref)
    if (handedOff) return handedOff

    // A terminal task is settled history, not available work. Keep the public
    // claim endpoint from reopening a task that already has a resolution; the
    // database function enforces the same invariant for direct RPC callers.
    if (task.status === 'done' || task.status === 'cancelled') {
      return fail(
        'validation_failed',
        `Cannot claim ${params.ref}: it is already ${task.status}. Reopen it explicitly first if the work needs revision.`,
      )
    }

    const { row, error } = await takeTask(actor, task, {
      agent: body.agent,
      setDoing: body.setDoing,
    })
    if (error) return fail('internal_error', error)

    if (!row) {
      // Handed off between the read above and the claim: the database refused
      // it, and the caller is owed the real reason.
      const now = await findTask(actor, params.ref, TASK_LIST_FIELDS)
      const handedOffNow = refuseHandedOff(now, refOfRow(task) ?? params.ref)
      if (handedOffNow) return handedOffNow

      const holder = task.claimed_by as string | null
      const lastBeat = task.heartbeat_at as string | null
      const agoMinutes = lastBeat
        ? Math.floor((Date.now() - new Date(lastBeat).getTime()) / 60000)
        : null
      return fail(
        'already_claimed',
        `Held by ${holder}${agoMinutes !== null ? `, last heartbeat ${agoMinutes}m ago` : ''}. ` +
          `Pick different work; a lease becomes stealable after ${CLAIM_LEASE_SECONDS / 60}m of silence.`,
        { claimedBy: holder, heartbeatAt: lastBeat },
      )
    }

    return ok(await withAssignee(row))
  },
})
