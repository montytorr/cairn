import { admin } from '@/lib/supabase/admin'
import type { Actor } from './auth'
import { recordActivity } from './activity'

/**
 * The backstop for runtimes with no session-end event.
 *
 * Claude Code has SessionEnd, so its claims get closed out the moment a session
 * does. Codex has only Stop, and OpenClaw has neither — its nearest equivalents
 * are `command:new` and a daily auto-reset. So on those runtimes a claim
 * outlives the session that took it, and the board fills with holds nobody is
 * acting on. Five were already sitting there when this was written.
 *
 * Run on a schedule (`openclaw automations`, cron, a launchd job), this
 * releases what the agent stopped working on and says so on the task.
 *
 * It deliberately never closes anything. A task without a resolution that
 * someone meant is worse than an open one: it looks answered and is not.
 */

/** Matches the claim route's lease. Past this, a claim is takeable by anyone anyway. */
const LEASE_MINUTES = 15

export type Reconciled = {
  released: { ref: string; heldForMinutes: number; hadCheckpoint: boolean }[]
  quiet: { ref: string; lastNoteAt: string | null }[]
}

export const reconcileClaims = async (
  actor: Actor,
  options: { olderThanMinutes?: number; dryRun?: boolean } = {},
): Promise<Reconciled> => {
  const lease = options.olderThanMinutes ?? LEASE_MINUTES
  const cutoff = new Date(Date.now() - lease * 60_000).toISOString()

  if (!actor.actorId) return { released: [], quiet: [] }

  const { data, error } = await admin()
    .from('tasks')
    .select(
      'id, number, status, claimed_at, heartbeat_at, checkpoint_summary, ' +
        'project:projects!project_id!inner(key, owner_user_id)',
    )
    .eq('projects.owner_user_id', actor.userId)
    .eq('claimed_by', actor.actorId)
    .lt('heartbeat_at', cutoff)

  if (error) throw new Error(error.message)

  const stale = (data ?? []) as unknown as {
    id: string
    number: number
    claimed_at: string | null
    heartbeat_at: string | null
    checkpoint_summary: string | null
    project: { key: string }
  }[]

  const released: Reconciled['released'] = []

  for (const task of stale) {
    const ref = `${task.project.key}-${task.number}`
    const heldForMinutes = task.claimed_at
      ? Math.round((Date.now() - new Date(task.claimed_at).getTime()) / 60_000)
      : 0

    if (!options.dryRun) {
      const { error: releaseError } = await admin()
        .from('tasks')
        .update({ claimed_by: null, claimed_at: null, heartbeat_at: null })
        .eq('id', task.id)
      if (releaseError) throw new Error(releaseError.message)

      // Say why it was let go, so the next reader is not left guessing whether
      // the work stopped deliberately.
      await admin()
        .from('task_notes')
        .insert({
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          kind: 'handoff',
          note:
            `Claim released automatically: no heartbeat for ${lease} minutes. ` +
            (task.checkpoint_summary
              ? 'The checkpoint above is where it was left.'
              : 'No checkpoint was recorded, so the state is whatever the last note says.'),
          content_hash: `reconcile-${task.id}-${task.heartbeat_at ?? 'none'}`,
        })

      await recordActivity([
        {
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId ?? 'unknown',
          event: 'released',
          data: { reason: 'reconcile', heldForMinutes },
        },
      ])
    }

    released.push({ ref, heldForMinutes, hadCheckpoint: Boolean(task.checkpoint_summary) })
  }

  return { released, quiet: [] }
}
