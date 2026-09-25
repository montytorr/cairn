import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { byTitle } from '@/lib/utils'
import { recordActivity } from '@/lib/api/activity'
import { formerKeysByProject } from '@/lib/api/project-keys'

export const dynamic = 'force-dynamic'

const createProject = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'key must be 2-10 uppercase alphanumerics, e.g. CAI'),
  title: z.string().min(1).max(200),
  description: z.string().max(100_000).optional(),
})

export const GET = route({
  handler: async ({ url }) => {
    // Archived projects are hidden unless asked for: an agent listing projects
    // to decide where to file work should not be offered a retired one.
    const includeArchived = url.searchParams.get('archived') === '1'

    const query = admin()
      .from('projects')
      .select('id, key, title, description, status, task_counter, created_at, updated_at')

    const { data, error } = await (includeArchived ? query : query.eq('status', 'active'))
      .order('title')
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    // Sorted here, not in SQL: this collation orders case-sensitively, which
    // puts every lowercase title below every capitalised one.
    const projects = ((data ?? []) as { id: string; title?: string }[]).sort(byTitle)

    // What each project used to be called. A key change was listed nowhere, so
    // someone holding AC-113 had no way to find that AC is now HOL short of
    // trying the ref (CAIRN-264). Last in each row, so a TSV reader keyed on
    // the columns it already knows is not disturbed.
    const former = await formerKeysByProject(projects.map((p) => p.id))
    return ok(projects.map((p) => ({ ...p, former_keys: former.get(p.id) ?? [] })))
  },
})

export const POST = route({
  schema: createProject,
  handler: async ({ actor, body }) => {
    const { data, error } = await admin()
      .from('projects')
      .insert({ ...body, owner_user_id: actor.userId })
      .select('id, key, title, description, status, created_at')
      .single()

    if (!error && data) {
      // A project appearing is activity. None of the project lifecycle was
      // recorded anywhere, so the timeline could not answer "where did this
      // come from" about the container every task lives in.
      await recordActivity([
        {
          project_id: (data as { id: string }).id,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          event: 'project_created',
          data: { key: body.key, title: body.title },
        },
      ], actor.userId, actor.host)
    }

    if (error) {
      return failFromDb(error, { '23505': `A project with key ${body.key} already exists.` })
    }

    return ok(data, { status: 201 })
  },
})
