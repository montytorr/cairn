import { admin } from '@/lib/db/client'
import type { Actor } from './auth'

export type ActivityEvent = {
  task_id: string
  actor_type: string
  actor_id: string
  event: string
  data: Record<string, unknown>
}

/**
 * Fire-and-forget, and deliberately so: an audit trail must never be the
 * reason a legitimate write fails. Errors are logged, not raised.
 */
export const recordActivity = async (events: ActivityEvent[]) => {
  if (events.length === 0) return
  const { error } = await admin().from('task_activity_events').insert(events)
  if (error) console.error('[activity] could not record', error.message, events.length)
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a === b

/**
 * Diffs a task against the patch about to be applied and turns each real
 * change into an event.
 *
 * Only the fields worth a line in a history: `description` is included as a
 * bare "edited" with no values, because a before/after of 1.9MB of markdown
 * is not a history entry, it is a denial of service on the reader.
 */
export const diffTaskEvents = (
  actor: Actor,
  taskId: string,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): ActivityEvent[] => {
  const events: ActivityEvent[] = []
  const push = (event: string, data: Record<string, unknown> = {}) =>
    events.push({
      task_id: taskId,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event,
      data,
    })

  const FIELDS: [string, string][] = [
    ['status', 'status_changed'],
    ['priority', 'priority_changed'],
    ['type', 'type_changed'],
    ['title', 'renamed'],
    ['labels', 'labels_changed'],
    ['due_date', 'due_date_changed'],
  ]

  for (const [column, event] of FIELDS) {
    if (patch[column] === undefined) continue
    if (same(patch[column], before[column])) continue
    push(event, { from: before[column] ?? null, to: patch[column] ?? null })
  }

  if (patch.description !== undefined && patch.description !== before.description) {
    push('body_edited')
  }

  // A resolution appearing is the single most important thing that happens to
  // a task, so it gets its own event rather than hiding inside status_changed.
  if (patch.resolution !== undefined && patch.resolution !== before.resolution) {
    push(before.resolution ? 'resolution_revised' : 'resolved', {
      kind: patch.resolution_kind ?? before.resolution_kind ?? null,
    })
  }

  if (
    patch.duplicate_of !== undefined &&
    // `?? null` because a caller that did not select the column would
    // otherwise make every write look like a change.
    patch.duplicate_of !== (before.duplicate_of ?? null)
  ) {
    push(patch.duplicate_of ? 'marked_duplicate' : 'duplicate_cleared')
  }

  // Closing releases a claim, which is a consequence rather than a decision.
  // Recorded so a reader is not left wondering where the holder went.
  if (patch.claimed_by === null && before.claimed_by) {
    push('released', { agent: before.claimed_by, reason: 'closed' })
  }

  return events
}
