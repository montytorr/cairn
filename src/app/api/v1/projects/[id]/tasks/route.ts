import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { resolveProject } from '@/lib/api/project-keys'
import { resolveAssignee, withAssignees } from '@/lib/api/people'
import { createTaskInProject } from '@/lib/api/task-create'
import { isLabEnabled } from '@/lib/api/lab-settings'
import { noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { withLabFields } from '@/lib/api/task-lab-fields'
import { createTaskSchema, TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  label: z.string().optional(),
  /**
   * Held by the caller. The server answers this, because only the server knows
   * who is asking — the CLI used to guess from a CAIRN_AGENT environment
   * variable and sent an empty string when it was unset, which asked for tasks
   * held by nobody and got an answer that looked like an answer.
   */
  // A plain string rather than a two-value z.enum. The activity-event guard
  // scans raw source for two-element lowercase string arrays in any file that
  // mentions FIELDS, and reads the second element as an event name the
  // database would reject — it caught the enum, and then caught the comment
  // explaining the enum. A heuristic that fails loudly is the right kind, so
  // the code moves rather than the guard.
  mine: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** Kept for callers that genuinely want somebody else's holdings. */
  claimed_by: z.string().optional(),
  /**
   * Whose tasks: `me`, an email, a display name or a user id. Unlike `mine`,
   * which is what this agent holds right now, this is what a human owns.
   */
  assignee: z.string().trim().min(1).max(320).optional(),
  /** Exact, not a search: the identifier another tool gave it. */
  external_ref: z.string().min(1).max(200).optional(),
  /** A subject's todos here (`LAB-12`), or `none`. Only while the Lab is on. */
  subject: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params, url }) => {
    // By uuid, live key, or a key the project used to have. `cairn list
    // --project AC` said "No project AC." about a project that had only been
    // renamed; it now lists HOL and says so in `renamed_from` (CAIRN-264).
    const resolved = await resolveProject(params.id)
    if (!resolved) return fail('not_found', `No project ${params.id}.`)
    const { project, renamed } = resolved

    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad query parameters.')
    const { status, type, label, mine, claimed_by, assignee, external_ref, subject, limit, offset } = parsed.data

    let query = admin()
      .from('tasks')
      .select(TASK_LIST_FIELDS, { count: 'exact' })

    // A task filed elsewhere can still belong here. Its home project keeps the
    // ref; these links only widen where it shows up, so the list is the union.
    const { data: guests, error: guestError } = await admin()
      .from('task_projects')
      .select('task_id')
      .eq('project_id', project.id)
    if (guestError) return fail('internal_error', guestError.message)

    const guestIds = (guests ?? []).map((g) => g.task_id as string)
    query =
      guestIds.length > 0
        ? query.or(`project_id.eq.${project.id},id.in.(${guestIds.join(',')})`)
        : query.eq('project_id', project.id)

    if (status) query = query.eq('status', status)
    if (type) query = query.eq('type', type)
    if (label) query = query.contains('labels', [label])
    if (claimed_by) query = query.eq('claimed_by', claimed_by)
    if (external_ref) query = query.eq('external_ref', external_ref)
    if (subject && (await isLabEnabled())) {
      if (subject.toLowerCase() === 'none') {
        query = query.is('subject_id', null)
      } else {
        const found = await resolveSubject(subject)
        if (!found) return noSuchSubject(subject)
        query = query.eq('subject_id', found.id)
      }
    }
    if (assignee) {
      const owner = await resolveAssignee(assignee, actor.userId)
      if (!owner.ok) return fail(owner.code, owner.error)
      query = query.eq('assignee_user_id', owner.person.id)
    }

    if (mine) {
      query = query.eq('claimed_by', actor.actorId)
      /**
       * And this session, when the caller can name one.
       *
       * `claimed_by` is an actorLabel shared by every Claude Code session on a
       * machine, so on its own `--mine` answers "this human's agents" while
       * reading like "this session". Four sessions run here at once.
       *
       * A claim with no session is still the caller's: it predates the column
       * or came from a runtime that cannot name itself, and "cannot tell" must
       * not become "not yours" — the same rule the release guard and `cairn
       * next` follow.
       *
       * Interpolated into the expression rather than parameterised because the
       * adapter's `or` takes a PostgREST string. Safe because `sessionId` is
       * matched against /^[A-Za-z0-9._:-]+$/ at authentication and is null if
       * it does not fit; nothing else reaches here.
       */
      if (actor.sessionId) {
        query = query.or(`claimed_session.is.null,claimed_session.eq.${actor.sessionId}`)
      }
    }

    const { data, error, count } = await query
      .order('position')
      .order('number', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return failFromDb(error)
    return ok({ count, offset, limit, tasks: await withAssignees(data ?? []), ...(renamed ? { renamed_from: renamed } : {}) })
  },
})

/**
 * A task create may name the subject it is a todo of (docs/lab.md), filed in
 * this project. Read only while the Lab is on; ignored while it is off.
 */
const createBody = createTaskSchema.and(z.object({ subject: z.string().trim().min(1).max(60).nullable().optional() }))

export const POST = route<{ id: string }, z.infer<typeof createBody>>({
  schema: createBody,
  secretFields: ['title', 'description', 'externalRef', 'externalUrl'],
  handler: async ({ actor, params, body }) => {
    const resolved = await resolveProject<{ id: string; key: string; status: string }>(
      params.id,
      'id, key, status',
    )
    if (!resolved) return fail('not_found', `No project ${params.id}.`)
    const { project, renamed } = resolved

    let subjectId: string | null | undefined
    if (body.subject !== undefined && (await isLabEnabled())) {
      if (body.subject === null) {
        subjectId = null
      } else {
        const subject = await resolveSubject(body.subject)
        if (!subject) return noSuchSubject(body.subject)
        subjectId = subject.id
      }
    }

    const created = await createTaskInProject(actor, project, body, {
      subjectId,
      retry: `cairn add "<title>" --project ${project.key} --body -`,
    })
    if (!created.ok) return created.response

    const told = renamed ? { renamed_from: renamed } : {}
    const [task] = await withLabFields([created.task])
    if (created.duplicate) return ok({ ...task, duplicate: true, ...told }, { status: 200 })
    return ok({ ...task, ...told }, { status: 201 })
  },
})
