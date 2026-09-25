import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { recordActivity } from '@/lib/api/activity'
import type { Actor } from '@/lib/api/auth'
import { removeAttachments } from '@/lib/attachments'
import { formerKeysByProject, resolveProject } from '@/lib/api/project-keys'

export const dynamic = 'force-dynamic'

type ProjectRow = {
  id: string
  key: string
  title: string
  description: string | null
  status: string
  task_counter: number
}

/**
 * By uuid, live key, or a key the project used to have. A retired key acts on
 * the live project and says so in `renamed_from`, rather than answering "No
 * project AC" about a project that was only renamed (CAIRN-264).
 */
const resolve = (idOrKey: string) =>
  resolveProject<ProjectRow>(idOrKey, 'id, key, title, description, status, task_counter')

const updateProject = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(100_000).nullable().optional(),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional(),
  status: z.enum(['planning', 'active', 'paused', 'completed', 'archived']).optional(),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const resolved = await resolve(params.id)
    if (!resolved) return fail('not_found', `No project ${params.id}.`)
    const { project, renamed } = resolved

    const [{ count }, former] = await Promise.all([
      admin()
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id),
      formerKeysByProject([project.id]),
    ])

    return ok({
      ...project,
      task_count: count ?? 0,
      former_keys: former.get(project.id) ?? [],
      ...(renamed ? { renamed_from: renamed } : {}),
    })
  },
})

/**
 * What changed about the project itself.
 *
 * Renames, key changes and archiving are the edits a reader is most likely to
 * be confused by later — "why is this called that" — and none of them appeared
 * anywhere. Status is split into archived/restored rather than recorded as a
 * field change, because those are the two that mean something to a person.
 */
const recordProjectChanges = async (
  actor: Actor,
  // The row comes back from the adapter loosely typed; only these four fields
  // are read, and they are read as strings.
  before: Record<string, unknown>,
  body: { title?: string; key?: string; status?: string },
  renaming: boolean,
) => {
  const events: Parameters<typeof recordActivity>[0] = []
  const id = String(before.id)
  const key = String(before.key ?? '')
  const title = String(before.title ?? '')
  const status = String(before.status ?? '')
  const base = { project_id: id, actor_type: actor.actorType, actor_id: actor.actorId }

  if (renaming && body.key) {
    events.push({ ...base, event: 'project_key_changed', data: { from: key, to: body.key } })
  }
  if (body.title && body.title !== title) {
    events.push({ ...base, event: 'project_renamed', data: { from: title, to: body.title } })
  }
  if (body.status && body.status !== status) {
    if (body.status === 'archived') {
      events.push({ ...base, event: 'project_archived', data: { key } })
    } else if (status === 'archived') {
      events.push({ ...base, event: 'project_restored', data: { key, to: body.status } })
    }
  }
  await recordActivity(events, actor.userId, actor.host)
}

export const PATCH = route<{ id: string }, z.infer<typeof updateProject>>({
  schema: updateProject,
  handler: async ({ actor, params, body }) => {
    const resolved = await resolve(params.id)
    if (!resolved) return fail('not_found', `No project ${params.id}.`)
    const { project, renamed: reachedThrough } = resolved
    const told = reachedThrough ? { renamed_from: reachedThrough } : {}
    if (Object.keys(body).length === 0) {
      return fail('validation_failed', 'No fields to update.')
    }

    // A key change is not a field update. Every ref already issued under the
    // old key — in commit messages, PR titles, other agents' notes — has to go
    // on resolving, so the rename and the record of what the key used to be
    // happen in one statement rather than two round trips that can half-fail.
    const { key, ...fields } = body
    const renaming = key !== undefined && key !== project.key

    if (renaming) {
      // Who did it is recorded on the former key itself, so "who renamed
      // this" does not depend on an activity row surviving.
      const { error } = await admin().rpc('project_rename_key', {
        p_project: project.id,
        p_new_key: key,
        p_actor: actor.actorId,
      })
      if (error) {
        return failFromDb(error, {
          '23505':
            `${key} is already in use, or was retired by another project. ` +
            `Reusing a retired key would leave every ${key}-n ref pointing at two tasks.`,
        })
      }
    }

    if (Object.keys(fields).length === 0) {
      const { data } = await admin()
        .from('projects')
        .select('id, key, title, description, status')
        .eq('id', project.id)
        .single()
      await recordProjectChanges(actor, project, body, renaming)
      return ok({ ...(data as object), former_key: renaming ? project.key : undefined, ...told })
    }

    const { data, error } = await admin()
      .from('projects')
      .update(fields)
      .eq('id', project.id)
      .select('id, key, title, description, status')
      .single()

    if (error) return failFromDb(error)
    await recordProjectChanges(actor, project, body, renaming)
    return ok({ ...(data as object), former_key: renaming ? project.key : undefined, ...told })
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
    // Resolved through a retired key like everything else, but the
    // confirmation below must still be the LIVE key: deleting a project is the
    // one place where "AC" meaning "what AC became" should not be enough.
    const project = (await resolve(params.id))?.project
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

    // Before the delete: project_id detaches rather than cascading, but only a
    // row that already exists can survive.
    await recordActivity([
      {
        project_id: project.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'project_deleted',
        data: { key: project.key, title: project.title, tasks: count ?? 0 },
      },
    ], actor.userId, actor.host)

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
