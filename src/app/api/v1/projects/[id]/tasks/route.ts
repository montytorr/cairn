import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { createTaskSchema, TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  label: z.string().optional(),
  claimed_by: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

/** Resolves a project by uuid or by its short key, scoped to the owner. */
const resolveProject = async (userId: string, idOrKey: string) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrKey)
  const q = admin().from('projects').select('id, key').eq('owner_user_id', userId)
  const { data } = isUuid
    ? await q.eq('id', idOrKey).maybeSingle()
    : await q.eq('key', idOrKey.toUpperCase()).maybeSingle()
  return data
}

export const GET = route<{ id: string }>({
  handler: async ({ actor, params, url }) => {
    const project = await resolveProject(actor.userId, params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad query parameters.')
    const { status, type, label, claimed_by, limit, offset } = parsed.data

    let query = admin()
      .from('tasks')
      .select(TASK_LIST_FIELDS, { count: 'exact' })
      .eq('projects.owner_user_id', actor.userId)

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

    const { data, error, count } = await query
      .order('position')
      .order('number', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return failFromDb(error)
    return ok({ count, offset, limit, tasks: data })
  },
})

export const POST = route<{ id: string }, z.infer<typeof createTaskSchema>>({
  schema: createTaskSchema,
  handler: async ({ actor, params, body }) => {
    const project = await resolveProject(actor.userId, params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    // A new task has no id yet, so it cannot be its own ancestor — the cycle
    // walk that re-parenting needs is unnecessary here.
    let parentId: string | null = null
    if (body.parentRef) {
      const parent = await findTask(actor, body.parentRef, 'id')
      if (!parent) return fail('not_found', `No task ${body.parentRef}.`)
      parentId = parent.id
    }

    const { data, error } = await admin()
      .from('tasks')
      .insert({
        project_id: project.id,
        parent_id: parentId,
        title: body.title,
        description: body.description ?? null,
        type: body.type,
        status: body.status,
        priority: body.priority,
        labels: body.labels,
        due_date: body.dueDate ?? null,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
      })
      .select('id, number, title, type, status, priority, labels, created_at')
      .single()

    if (error) return failFromDb(error)

    await admin().from('task_activity_events').insert({
      task_id: data.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: 'created',
      data: { type: body.type, status: body.status },
    })

    return ok({ ...data, ref: `${project.key}-${data.number}` }, { status: 201 })
  },
})
