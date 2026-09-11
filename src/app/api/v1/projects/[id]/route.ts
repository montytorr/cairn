import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { removeAttachments } from '@/lib/attachments'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const resolve = async (userId: string, idOrKey: string) => {
  const q = admin()
    .from('projects')
    .select('id, key, title, description, status, task_counter')
    .eq('owner_user_id', userId)
  const { data } = UUID.test(idOrKey)
    ? await q.eq('id', idOrKey).maybeSingle()
    : await q.eq('key', idOrKey.toUpperCase()).maybeSingle()
  return data
}

const updateProject = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(100_000).nullable().optional(),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional(),
  status: z.enum(['planning', 'active', 'paused', 'completed', 'archived']).optional(),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const project = await resolve(actor.userId, params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const { count } = await admin()
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id)

    return ok({ ...project, task_count: count ?? 0 })
  },
})

export const PATCH = route<{ id: string }, z.infer<typeof updateProject>>({
  schema: updateProject,
  handler: async ({ actor, params, body }) => {
    const project = await resolve(actor.userId, params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)
    if (Object.keys(body).length === 0) {
      return fail('validation_failed', 'No fields to update.')
    }

    const { data, error } = await admin()
      .from('projects')
      .update(body)
      .eq('id', project.id)
      .select('id, key, title, description, status')
      .single()

    if (error) {
      return failFromDb(error, { '23505': `A project with key ${body.key} already exists.` })
    }
    return ok(data)
  },
})

/**
 * Deletes a project and everything in it.
 *
 * Tasks cascade from the schema, and notes, comments, attachments and
 * activity cascade from the tasks. So this is genuinely irreversible, and it
 * requires the caller to name the project key in `confirm` — a project with
 * 691 tasks should not be removable by a mistyped DELETE.
 */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params, url }) => {
    const project = await resolve(actor.userId, params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const { count } = await admin()
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id)

    const confirm = url.searchParams.get('confirm')
    if (confirm !== project.key) {
      return fail(
        'validation_failed',
        `This deletes ${count ?? 0} task${count === 1 ? '' : 's'} and everything attached to them, ` +
          `and cannot be undone. Repeat the project key to confirm: ?confirm=${project.key}`,
        { taskCount: count ?? 0, requiresConfirmation: project.key },
      )
    }

    // Storage objects are not covered by the database cascade, so they have
    // to be removed explicitly or the bucket keeps orphans forever.
    const { data: files } = await admin()
      .from('task_attachments')
      .select('storage_path, task:tasks!inner(project_id)')
      .eq('tasks.project_id', project.id)

    const paths = ((files ?? []) as unknown as { storage_path: string }[]).map(
      (f) => f.storage_path,
    )
    if (paths.length > 0) {
      await removeAttachments(paths)
    }

    const { error } = await admin().from('projects').delete().eq('id', project.id)
    if (error) return failFromDb(error)

    return ok({
      deleted: true,
      key: project.key,
      tasksRemoved: count ?? 0,
      filesRemoved: paths.length,
    })
  },
})
