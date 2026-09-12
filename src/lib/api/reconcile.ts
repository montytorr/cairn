import { admin } from '@/lib/db/client'
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

/**
 * Deliberately far longer than the 15-minute claim lease.
 *
 * The lease answers "may someone else take this", and 15 minutes is right for
 * that: a takeover is recoverable. Releasing is different, and the measured
 * reality is that agents barely heartbeat -- 3 of 6 live claims had never
 * beaten once, and the claim this was written under had not either. A
 * 15-minute release would have cancelled work in progress.
 */
const QUIET_MINUTES = 120

export type Reconciled = {
  released: { ref: string; heldForMinutes: number; hadCheckpoint: boolean; reopened: boolean }[]
  quiet: { ref: string; lastNoteAt: string | null }[]
}

export const reconcileClaims = async (
  actor: Actor,
  options: { olderThanMinutes?: number; dryRun?: boolean } = {},
): Promise<Reconciled> => {
  const quietFor = options.olderThanMinutes ?? QUIET_MINUTES
  const cutoff = Date.now() - quietFor * 60_000

  if (!actor.actorId) return { released: [], quiet: [] }

  const { data, error } = await admin()
    .from('tasks')
    .select(
      'id, number, status, claimed_at, heartbeat_at, checkpoint_at, updated_at, ' +
        'checkpoint_summary, project:projects!project_id!inner(key, owner_user_id)',
    )
    .eq('projects.owner_user_id', actor.userId)
    .eq('claimed_by', actor.actorId)

  if (error) throw new Error(error.message)

  const held = (data ?? []) as unknown as {
    id: string
    number: number
    status: string
    claimed_at: string | null
    heartbeat_at: string | null
    checkpoint_at: string | null
    updated_at: string | null
    checkpoint_summary: string | null
    project: { key: string }
  }[]

  // Every sign of life counts, not just an explicit beat. A task being worked
  // on accumulates notes, checkpoints and edits whether or not anyone remembers
  // to call `cairn beat`, and releasing over a missing beat alone would punish
  // the agents doing the work most carefully.
  const lastNotes = await lastNoteTimes(held.map((t) => t.id))

  const lastSignOfLife = (task: (typeof held)[number]) =>
    Math.max(
      ...[
        task.heartbeat_at,
        task.claimed_at,
        task.checkpoint_at,
        task.updated_at,
        lastNotes.get(task.id) ?? null,
      ]
        .filter(Boolean)
        .map((iso) => new Date(iso as string).getTime()),
    )

  const stale = held.filter((task) => lastSignOfLife(task) < cutoff)

  const released: Reconciled['released'] = []

  for (const task of stale) {
    const ref = `${task.project.key}-${task.number}`
    const heldForMinutes = task.claimed_at
      ? Math.round((Date.now() - new Date(task.claimed_at).getTime()) / 60_000)
      : 0

    // Releasing the claim without touching the status left the worst of
    // both: the board went on saying "in progress" while nobody was on it,
    // and the task fell out of every list that would have surfaced it again —
    // not "held by someone", not "stale claim, takeable", just a row in the
    // In Progress column that nobody owned. Ten had piled up that way.
    //
    // Moving it back to todo is not closing it. The checkpoint and the notes
    // are untouched; what changes is that `doing` starts meaning what it says.
    const reopen = task.status === 'doing'

    if (!options.dryRun) {
      const { error: releaseError } = await admin()
        .from('tasks')
        .update({
          claimed_by: null,
          claimed_at: null,
          heartbeat_at: null,
          ...(reopen ? { status: 'todo' } : {}),
        })
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
            `Claim released automatically: nothing happened on this task for ${quietFor} minutes. ` +
            (task.checkpoint_summary
              ? 'The checkpoint above is where it was left. '
              : 'No checkpoint was recorded, so the state is whatever the last note says. ') +
            (reopen
              ? 'Moved back to todo, because nobody is working on it — pick it up and finish it, or close it with a resolution.'
              : ''),
          content_hash: `reconcile-${task.id}-${task.heartbeat_at ?? 'none'}`,
        })

      await recordActivity([
        {
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId ?? 'unknown',
          event: 'released',
          data: { reason: 'reconcile', heldForMinutes, reopened: reopen },
        },
      ])
    }

    released.push({
      ref,
      heldForMinutes,
      hadCheckpoint: Boolean(task.checkpoint_summary),
      reopened: reopen,
    })
  }

  return {
    released,
    quiet: held
      .filter((task) => !stale.includes(task))
      .map((task) => ({
        ref: `${task.project.key}-${task.number}`,
        lastNoteAt: lastNotes.get(task.id) ?? null,
      })),
  }
}

/** Most recent note per task, as the strongest evidence a claim is alive. */
const lastNoteTimes = async (taskIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out

  const { data, error } = await admin()
    .from('task_notes')
    .select('task_id, created_at')
    .in('task_id', taskIds)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    const id = row.task_id as string
    if (!out.has(id)) out.set(id, row.created_at as string)
  }
  return out
}
