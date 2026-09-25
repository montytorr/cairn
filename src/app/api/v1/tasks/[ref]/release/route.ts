import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/**
 * Drops a claim without closing the task. This is the whole of "handoff" —
 * release, having left a checkpoint. No contract, no invitation, no accept.
 */
const releaseBody = z.object({
  ownershipVersion: z.number().int().nonnegative().optional(),
  /** Release a claim another session holds. Say so on purpose. */
  force: z.boolean().default(false),
})

export const POST = route<{ ref: string }, z.infer<typeof releaseBody>>({
  schema: releaseBody,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    /**
     * Whose claim this actually is.
     *
     * `claimed_by` is an actorLabel, and every Claude Code session on a machine
     * writes the same one — so matching on it alone let one session release
     * another's claim and neither could see it happen. Compared here rather
     * than in release_task_atomic because this is a guard on intent, not on
     * the atomic swap: the RPC still enforces holder and version, and losing
     * the race between this check and that one leaves exactly the behaviour
     * that shipped before this existed.
     *
     * Only when BOTH sides can name a session. A NULL on the task means the
     * claim predates this or came from a runtime with no session to give, and
     * refusing those would break releasing on every runtime that cannot
     * identify itself.
     */
    const holder = task.claimed_session as string | null
    if (!body.force && holder && actor.sessionId && holder !== actor.sessionId) {
      return fail(
        'conflict',
        `${params.ref} is held by session ${holder}, not this one. ` +
          `Ask it to release, or pass force if you know it is gone.`,
      )
    }

    const version = body.ownershipVersion ?? Number(task.ownership_version ?? 0)
    const expectedHolder = actor.actorType === 'agent' ? actor.actorId : null
    const { data, error } = await admin().rpc<Record<string, unknown> | null>('release_task_atomic', {
      p_task_id: task.id,
      p_owner_user_id: actor.userId,
      p_actor_type: actor.actorType,
      p_actor_id: actor.actorId,
      p_expected_version: version,
      p_expected_holder: expectedHolder,
    })

    if (error) return fail('internal_error', error.message)
    if (!data) return fail('conflict', 'Claim ownership changed; nothing was released.')

    // release_task_atomic clears claimed_session with the claim (063): left
    // behind it would answer "which session holds this" with one that does
    // not. It also moves a held `doing` task back to `todo`, as the reaper
    // does, so a released task stops saying somebody is on it.
    return ok(data)
  },
})
