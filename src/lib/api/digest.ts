import { admin } from '@/lib/supabase/admin'

/** Roughly four characters per token. Order-of-magnitude, on purpose. */
const tokens = (text: string | null | undefined) => Math.ceil((text?.length ?? 0) / 4)

/**
 * How much description survives into a digest. Enough to know what the task
 * asks for; measured against real data, where the median body is 2KB and the
 * 90th percentile is 5KB, so passing it through whole would save nothing.
 */
const BODY_BUDGET = 800

/**
 * A cheap read of an expensive task.
 *
 * `show` returning everything means an agent either pays for the whole thing
 * or skips it. This is the middle: the answer in full, the durable parts of
 * the log, a clipped body, and an honest account of what was left out and what
 * it would cost to fetch.
 *
 * Attempts and plain notes are dropped. They are how the work went, which
 * matters while it is happening and rarely afterwards — findings and decisions
 * are what a later reader came for.
 */
export const buildDigest = async (task: Record<string, unknown>) => {
  const { data: notes } = await admin()
    .from('task_notes')
    .select('kind, note, actor_id, created_at')
    .eq('task_id', task.id as string)
    .order('created_at')

  const all = (notes ?? []) as { kind: string; note: string; actor_id: string; created_at: string }[]
  const durable = all.filter((n) => n.kind === 'finding' || n.kind === 'decision')
  const dropped = all.filter((n) => n.kind !== 'finding' && n.kind !== 'decision')

  const description = (task.description as string | null) ?? null
  const clipped = description && description.length > BODY_BUDGET

  return {
    ref: task.ref ?? null,
    number: task.number,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    claimedBy: task.claimed_by,
    updatedAt: task.updated_at,

    // The answer, never clipped. It is the whole reason to look.
    resolution: task.resolution,
    resolutionKind: task.resolution_kind,

    description: clipped ? `${description!.slice(0, BODY_BUDGET)}…` : description,

    findings: durable.map((n) => ({
      kind: n.kind,
      note: n.note,
      by: n.actor_id,
      at: n.created_at,
    })),

    checkpoint: task.checkpoint_summary,
    blockedReason: task.blocked_reason,

    /** What this view withheld, and what asking for it costs. */
    omitted: {
      descriptionBytes: clipped ? description!.length - BODY_BUDGET : 0,
      attemptsAndNotes: dropped.length,
      tokensToFetchFull:
        tokens(description) + all.reduce((sum, n) => sum + tokens(n.note), 0),
      full: `?view=full`,
    },
  }
}
