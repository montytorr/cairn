import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { rankNext, type Candidate } from '@/lib/api/next'
import { resolveProject } from '@/lib/api/project-keys'
import { peopleByIds, resolveAssignee } from '@/lib/api/people'

export const dynamic = 'force-dynamic'

const nextQuery = z.object({
  project: z.string().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  assignee: z.string().trim().min(1).max(320).optional(),
})

type Row = {
  id: string
  number: number
  title: string
  status: string
  priority: string
  type: string | null
  claimed_by: string | null
  heartbeat_at: string | null
  updated_at: string | null
  checkpoint_summary: string | null
  blocked_at: string | null
  claimed_session: string | null
  assignee_user_id: string | null
  project: { key: string } | { key: string }[] | null
}

const keyOf = (project: Row['project']) =>
  (Array.isArray(project) ? project[0]?.key : project?.key) ?? ''

/**
 * What to pick up next.
 *
 * The ranking is in `@/lib/api/next` and is pure, so it can be argued with in
 * a test rather than against a database. This route's only job is to hand it
 * everything it needs to be right — which includes the dependency counts,
 * because a task waiting on unfinished work must never be recommended and the
 * task row alone cannot say whether it is.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = nextQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) {
      return fail('validation_failed', 'Bad query.', { issues: parsed.error.issues })
    }
    const query = parsed.data

    // Resolved before filtering, never matched as a string. `--project AC`
    // after AC became HOL filtered on a key no row carries any more and
    // answered "nothing open" about a project with open work — an answer that
    // reads as true (CAIRN-264). A key that was never anyone's is refused for
    // the same reason: "nothing open" is not what a typo deserves.
    const resolved = query.project ? await resolveProject(query.project) : null
    if (query.project && !resolved) return fail('not_found', `No project ${query.project}.`)
    const projectKey = resolved?.project.key

    // A name that matches nobody is refused, not treated as "nothing open" —
    // the same reason an unknown project is.
    const owner = query.assignee ? await resolveAssignee(query.assignee, actor.userId) : null
    if (owner && !owner.ok) return fail(owner.code, owner.error)

    const base = admin()
      .from('tasks')
      .select(
        'id, number, title, status, priority, type, claimed_by, claimed_session, heartbeat_at, updated_at, ' +
          'checkpoint_summary, blocked_at, assignee_user_id, project:projects!project_id!inner(key)',
      )
      .not('status', 'in', '("done","cancelled")')
      .neq('projects.status', 'archived')
      // A task handed off to another tracker is worked there: picking it here
      // would only meet 409 handed_off, and be picked again (docs/lab.md).
      .or('handoff_ref.is.null,handoff_status.in.(done,cancelled)')
    const scoped = projectKey ? base.eq('projects.key', projectKey) : base

    const { data } = await (owner?.ok ? scoped.eq('assignee_user_id', owner.person.id) : scoped)
      .order('updated_at', { ascending: true })
      .limit(500)

    const rows = (data ?? []) as unknown as Row[]

    // One query for every open dependency, rather than one per task. An unmet
    // dependency is the difference between a recommendation and a trap, so it
    // cannot be approximated.
    const { data: deps } = await admin()
      .from('task_deps')
      // Hinted by column rather than constraint name: the adapter matches either,
      // and a constraint name is a thing to guess wrong once and never notice.
      .select('blocked_id, blocking:tasks!blocking_id(status)')
      .in('blocked_id', rows.map((row) => row.id))

    const unmet = new Map<string, number>()
    for (const dep of (deps ?? []) as unknown as {
      blocked_id: string
      blocking: { status: string } | { status: string }[] | null
    }[]) {
      const blocking = Array.isArray(dep.blocking) ? dep.blocking[0] : dep.blocking
      if (!blocking || blocking.status === 'done' || blocking.status === 'cancelled') continue
      unmet.set(dep.blocked_id, (unmet.get(dep.blocked_id) ?? 0) + 1)
    }

    const people = await peopleByIds(rows.map((row) => row.assignee_user_id ?? ''))

    const candidates: Candidate[] = rows.map((row) => ({
      ref: `${keyOf(row.project)}-${row.number}`,
      title: row.title,
      status: row.status,
      priority: row.priority,
      type: row.type,
      claimedBy: row.claimed_by,
      claimedSession: row.claimed_session,
      heartbeatAt: row.heartbeat_at,
      updatedAt: row.updated_at,
      checkpoint: row.checkpoint_summary,
      blockedAt: row.blocked_at,
      unmetDeps: unmet.get(row.id) ?? 0,
      assigneeId: row.assignee_user_id,
      assignee: row.assignee_user_id ? (people.get(row.assignee_user_id)?.name ?? null) : null,
    }))

    const ranked = rankNext(candidates, {
      me: actor.actorId,
      mySession: actor.sessionId,
      myUserId: actor.userId,
    })
    return ok({
      pick: ranked[0] ?? null,
      then: ranked.slice(1, query.limit ?? 5),
      considered: candidates.length,
      offerable: ranked.length,
      ...(resolved?.renamed ? { renamed_from: resolved.renamed } : {}),
    })
  },
})
