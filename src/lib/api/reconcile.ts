import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { isUntouchedAutoCheckpoint } from '@/lib/checkpoint-origin'

/**
 * The backstop for claims that outlive the session that took them.
 *
 * No runtime releases on session end. Claude Code's SessionEnd records the
 * session and checkpoints what it held; Codex has only Stop, and OpenClaw has
 * neither — its nearest equivalents are `command:new` and a daily auto-reset.
 * So on every runtime a claim can outlive its session, and the board fills
 * with holds nobody is acting on: 22 were held when CAIRN-284 was filed, 17 of
 * them silent for more than 20 hours.
 *
 * Run on a schedule as the maintenance identity (`CAIRN_AGENT=maintenance
 * cairn reconcile`, installed by scripts/install-cron.mjs), this releases every
 * quiet claim in the workspace and says so on the task. Run by any other agent
 * it releases only that agent's own, which is all it ever did — and why the
 * scheduled job, holding nothing itself, released nothing for two weeks.
 *
 * A quiet `doing` task goes back to `todo`. An `in-review` one keeps its
 * status, because the work is written and the status says so; only the claim
 * goes. It deliberately never closes anything. A task without a resolution
 * that someone meant is worse than an open one: it looks answered and is not.
 */

/** The key agent name whose reconcile covers the whole workspace. */
export const MAINTENANCE_AGENT = 'maintenance'

/**
 * Whether this caller may release other agents' claims.
 *
 * From the key row's agent name, never from `actorId`: that string also
 * carries a display name any user can edit. Keys are created only by an
 * administrator, so naming one `maintenance` is itself the grant.
 */
export const reconcilesWorkspace = (actor: Pick<Actor, 'actorType' | 'agentName'>): boolean =>
  actor.actorType === 'agent' && actor.agentName === MAINTENANCE_AGENT

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
  scope: 'workspace' | 'own'
  released: {
    ref: string
    holder: string
    heldForMinutes: number
    hadCheckpoint: boolean
    reopened: boolean
  }[]
  quiet: { ref: string; lastNoteAt: string | null }[]
}

type HeldClaim = {
  id: string
  number: number
  status: string
  claimed_by: string
  claimed_at: string | null
  heartbeat_at: string | null
  checkpoint_at: string | null
  updated_at: string | null
  checkpoint_summary: string | null
  ownership_version: number
  project: { key: string }
}

/**
 * The last moment anything suggests somebody is on this claim.
 *
 * Every sign of life counts, not just an explicit beat. A task being worked
 * on accumulates notes, checkpoints and edits whether or not anyone remembers
 * to call `cairn beat`, and releasing over a missing beat alone would punish
 * the agents doing the work most carefully.
 *
 * Except the one written without anyone looking: "Still held, not progressed"
 * is the session-end hook recording that a claim was held while the session
 * worked elsewhere. Counting its timestamp let a runtime that records a
 * session every 30 minutes keep a week-old claim alive forever (CAIRN-283).
 */
export const lastSignOfLife = (
  task: Pick<HeldClaim, 'heartbeat_at' | 'claimed_at' | 'checkpoint_at' | 'updated_at' | 'checkpoint_summary'>,
  lastNoteAt: string | null,
): number =>
  Math.max(
    ...[
      task.heartbeat_at,
      task.claimed_at,
      isUntouchedAutoCheckpoint(task.checkpoint_summary) ? null : task.checkpoint_at,
      task.updated_at,
      lastNoteAt,
    ]
      .filter(Boolean)
      .map((iso) => new Date(iso as string).getTime()),
  )

export const releaseNote = (quietFor: number, hadCheckpoint: boolean, status: string) =>
  `Claim released automatically: nothing happened on this task for ${quietFor} minutes. ` +
  (hadCheckpoint
    ? 'The checkpoint above is where it was left. '
    : 'No checkpoint was recorded, so the state is whatever the last note says. ') +
  (status === 'doing'
    ? 'Moved back to todo, because nobody is working on it — pick it up and finish it, or close it with a resolution.'
    : status === 'in-review'
      ? 'Left in review: the work is written, and nobody holds it now — review it, or claim it to finish it.'
      : '')

export const reconcileClaims = async (
  actor: Actor,
  options: { olderThanMinutes?: number; dryRun?: boolean } = {},
): Promise<Reconciled> => {
  const quietFor = options.olderThanMinutes ?? QUIET_MINUTES
  const cutoff = Date.now() - quietFor * 60_000

  const workspace = reconcilesWorkspace(actor)
  const scope: Reconciled['scope'] = workspace ? 'workspace' : 'own'
  if (!actor.actorId) return { scope, released: [], quiet: [] }

  const query = admin()
    .from('tasks')
    .select(
      'id, number, status, claimed_by, claimed_at, heartbeat_at, checkpoint_at, updated_at, ' +
        'checkpoint_summary, ownership_version, project:projects!project_id!inner(key)',
    )
  const { data, error } = await (workspace
    ? query.not('claimed_by', 'is', null)
    : query.eq('claimed_by', actor.actorId))

  if (error) throw new Error(error.message)

  const held = (data ?? []) as unknown as HeldClaim[]

  const lastNotes = await lastNoteTimes(held.map((t) => t.id))

  const stale = held.filter((task) => lastSignOfLife(task, lastNotes.get(task.id) ?? null) < cutoff)

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
      const { data: didRelease, error: releaseError } = await admin().rpc<boolean>('reconcile_task_atomic', {
        p_task_id: task.id,
        p_owner_user_id: actor.userId,
        p_actor_type: actor.actorType,
        p_actor_id: actor.actorId,
        // The holder the snapshot saw, not the caller: in the workspace sweep
        // they differ, and the swap must still lose if the claim moved.
        p_expected_holder: task.claimed_by,
        p_expected_version: task.ownership_version,
        p_expected_heartbeat: task.heartbeat_at,
        p_expected_updated_at: task.updated_at,
        p_reopen: reopen,
        p_note: releaseNote(quietFor, Boolean(task.checkpoint_summary), task.status),
        p_content_hash: `reconcile-${task.id}-${task.ownership_version}-${task.heartbeat_at ?? 'none'}`,
      })
      if (releaseError) throw new Error(releaseError.message)
      if (!didRelease) continue
    }

    released.push({
      ref,
      holder: task.claimed_by,
      heldForMinutes,
      hadCheckpoint: Boolean(task.checkpoint_summary),
      reopened: reopen,
    })
  }

  return {
    scope,
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
