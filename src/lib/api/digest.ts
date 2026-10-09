import { admin } from '@/lib/db/client'
import { mentionsOf } from './mentions'

/** Roughly four characters per token. Order-of-magnitude, on purpose. */
const tokens = (text: string | null | undefined) => Math.ceil((text?.length ?? 0) / 4)

/**
 * How much description survives into a digest. Enough to know what the task
 * asks for; measured against real data, where the median body is 2KB and the
 * 90th percentile is 5KB, so passing it through whole would save nothing.
 */
export const BODY_BUDGET = 800

/**
 * Whether `next` is a digest's clipped description sent back as an edit.
 * Saving it would silently drop the tail of `stored`.
 */
export const looksLikeDigestClip = (next: string, stored: string | null | undefined): boolean =>
  !!stored && next.trimEnd().endsWith('…') && stored.length > BODY_BUDGET && next.length < stored.length

/** Mentions shown in a digest. The rest are one request away. */
const MENTION_BUDGET = 5

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
/** `CAI-42` for a task id, or null. Refs are addressable; uuids are not. */
const refOf = async (id: unknown): Promise<string | null> => {
  if (typeof id !== 'string') return null
  const { data } = await admin()
    .from('tasks')
    .select('number, project:projects!project_id!inner(key)')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as { number: number; project: { key: string } | { key: string }[] }
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  return `${project?.key}-${row.number}`
}

export const buildDigest = async (task: Record<string, unknown>) => {
  const [{ data: notes }, { count: childCount }, { count: childClosed }, duplicateOf, parent, mentioned] =
    await Promise.all([
      admin()
        .from('task_notes')
        .select('kind, note, actor_id, created_at')
        .eq('task_id', task.id as string)
        .order('created_at'),
      admin()
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_id', task.id as string),
      admin()
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_id', task.id as string)
        .in('status', ['done', 'cancelled']),
      refOf(task.duplicate_of),
      refOf(task.parent_id),
      mentionsOf(task.id as string, MENTION_BUDGET),
    ])

  const all = (notes ?? []) as { kind: string; note: string; actor_id: string; created_at: string }[]
  const durable = all.filter((n) => n.kind === 'finding' || n.kind === 'decision')
  const dropped = all.filter((n) => n.kind !== 'finding' && n.kind !== 'decision')

  const description = (task.description as string | null) ?? null
  const clipped = description && description.length > BODY_BUDGET

  const embedded = task.project as { key?: string } | { key?: string }[] | undefined
  const own = Array.isArray(embedded) ? embedded[0] : embedded

  return {
    ref: own?.key ? `${own.key}-${task.number}` : null,
    number: task.number,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    // Whose it is, and who is on it: a human owns the task, an agent holds it.
    assignee: (task.assignee as { name?: string } | null | undefined)?.name ?? null,
    createdBy: task.actor_id,
    claimedBy: task.claimed_by,
    // Which SESSION holds it, not just which human. claimedBy is an actorLabel
    // shared by every Claude Code session on a machine, so on its own it
    // cannot answer the question anybody actually asks of a held task.
    claimedSession: task.claimed_session,
    updatedAt: task.updated_at,

    // Where it came from in another tool, when it came from one.
    externalRef: task.external_ref ?? null,
    externalUrl: task.external_url ?? null,

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

    // Both belong in the cheapest view there is. A digest that hides "the real
    // work is over there" hands the reader an answer to the wrong question.
    duplicateOf,
    parent,
    children: childCount ? { total: childCount, closed: childClosed ?? 0 } : null,

    // Where other tasks named this one, decisions and findings first
    // (CAIRN-267). The case it exists for: a closure elsewhere that says "do
    // not read this as permission for <this task>", which nothing here
    // mentioned before.
    mentionedIn: mentioned.mentions.map((m) => ({
      ref: m.ref,
      status: m.status,
      source: m.kind ? `${m.source}:${m.kind}` : m.source,
      by: m.by,
      at: m.at,
      excerpt: m.excerpt,
    })),
    mentionedInTotal: mentioned.total,

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
