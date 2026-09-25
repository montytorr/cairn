import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const checkpointBody = z.object({
  summary: z.string().min(1).max(10_000),
  payload: z.record(z.string(), z.unknown()).optional(),
  ownershipVersion: z.number().int().nonnegative().optional(),
  checkpointVersion: z.number().int().nonnegative().optional(),
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
  secretFields: ['summary', 'payload'],
  handler: async ({ actor, params, body, req }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const idempotencyHeader = req.headers.get('idempotency-key')
    const parsedMutation = z.string().uuid().safeParse(idempotencyHeader)
    if (idempotencyHeader && !parsedMutation.success) return fail('validation_failed', 'Invalid idempotency key.')
    const existingClaim = task.claimed_by !== null && task.claimed_by !== undefined
    if (existingClaim && (body.ownershipVersion === undefined || body.checkpointVersion === undefined)) {
      return fail('conflict', 'Checkpoint requires ownership and checkpoint predecessors for an existing claim.')
    }
    if (idempotencyHeader && (body.ownershipVersion === undefined || body.checkpointVersion === undefined)) {
      return fail('conflict', 'Queued checkpoint has no ownership/checkpoint generation; replay refused.')
    }
    const mutationId = parsedMutation.success ? parsedMutation.data : randomUUID()
    const queuedHeader = req.headers.get('x-cairn-queued-at')
    const queuedAt = queuedHeader && !Number.isNaN(Date.parse(queuedHeader))
      ? new Date(queuedHeader).toISOString()
      : new Date().toISOString()
    const { data: result, error } = await admin().rpc<{
      code: string
      data?: Record<string, unknown>
      claimed?: boolean
      holder?: string
    }>('checkpoint_task_atomic', {
      p_task_id: task.id,
      p_owner_user_id: actor.userId,
      p_actor_type: actor.actorType,
      p_actor_id: actor.actorId,
      p_summary: body.summary,
      p_payload: body.payload ?? null,
      p_mutation_id: mutationId,
      p_queued_at: queuedAt,
      p_expected_version: body.ownershipVersion ?? null,
      p_expected_checkpoint_version: body.checkpointVersion ?? null,
    })

    if (error) return fail('internal_error', error.message)
    if (!result || result.code === 'not_found') return fail('not_found', `No task ${params.ref}.`)
    if (result.code === 'already_claimed') {
      return fail('already_claimed', `Held by ${result.holder}, not you.`, { claimedBy: result.holder })
    }
    if (result.code === 'ownership_changed') {
      return fail('conflict', 'Claim ownership changed; stale checkpoint refused.')
    }
    if (result.code === 'checkpoint_changed') {
      return fail('conflict', 'Checkpoint sequence changed; out-of-order checkpoint refused.')
    }
    if (result.code === 'missing_predecessor') {
      return fail('conflict', 'Checkpoint requires ownership and checkpoint predecessors for an existing claim.')
    }
    if (result.code === 'terminal') return fail('conflict', 'Closed tasks do not accept checkpoints.')
    return ok({ ...(result.data ?? {}), ...(result.claimed ? { claimed: true } : {}), replay: result.code })
  },
})
