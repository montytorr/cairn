import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const entityCreate = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words separated by single hyphens.'),
  title: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  projects: z.array(z.string().min(1).max(10)).max(60).default([]),
})

/**
 * Entities, with the projects in each.
 *
 * An entity is any grouping a fact can be true of — a business, a stack, a
 * subsystem. Many-to-many with projects on purpose: a project belongs to a
 * business AND sits on a stack, and a fact can be true for either reason.
 */
export const GET = route({
  handler: async ({ actor }) => {
    const { data, error } = await admin()
      .from('entities')
      .select('id, key, title, description, project_entities(project:projects(key))')
      .eq('owner_user_id', actor.userId)
      .order('key')

    if (error) return fail('internal_error', error.message)

    return ok({
      count: (data ?? []).length,
      results: (data ?? []).map((e) => ({
        key: e.key,
        title: e.title,
        description: e.description,
        projects: ((e.project_entities ?? []) as unknown as {
          project: { key: string } | { key: string }[] | null
        }[])
          .map((pe) => (Array.isArray(pe.project) ? pe.project[0]?.key : pe.project?.key))
          .filter((k): k is string => Boolean(k))
          .sort(),
      })),
    })
  },
})

export const POST = route({
  schema: entityCreate,
  handler: async ({ actor, body }) => {
    const { data, error } = await admin()
      .from('entities')
      .insert({
        owner_user_id: actor.userId,
        key: body.key,
        title: body.title,
        description: body.description,
      })
      .select('id, key, title')
      .single()

    if (error) {
      return fail(error.code === '23505' ? 'conflict' : 'internal_error', error.message)
    }

    if (body.projects.length > 0) {
      const keys = body.projects.map((k) => k.toUpperCase())
      const { data: projects, error: lookupError } = await admin()
        .from('projects')
        .select('id, key')
        .eq('owner_user_id', actor.userId)
        .in('key', keys)
      if (lookupError) return fail('internal_error', lookupError.message)

      const found = new Map((projects ?? []).map((p) => [p.key as string, p.id as string]))
      const missing = keys.filter((k) => !found.has(k))
      if (missing.length > 0) return fail('not_found', `No such project: ${missing.join(', ')}`)

      const { error: linkError } = await admin()
        .from('project_entities')
        .insert([...found.values()].map((project_id) => ({ project_id, entity_id: data.id })))
      if (linkError) return fail('internal_error', linkError.message)
    }

    return ok(data, { status: 201 })
  },
})

const entityPatch = z.object({
  key: z.string().min(2).max(40),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  addProjects: z.array(z.string().min(1).max(10)).max(60).default([]),
  removeProjects: z.array(z.string().min(1).max(10)).max(60).default([]),
})

/** Membership changes are additive/subtractive, not a wholesale replacement:
 *  assigning one project should not silently unassign thirty others. */
export const PATCH = route({
  schema: entityPatch,
  handler: async ({ actor, body }) => {
    const { data: entity } = await admin()
      .from('entities')
      .select('id')
      .eq('owner_user_id', actor.userId)
      .eq('key', body.key.toLowerCase())
      .maybeSingle()
    if (!entity) return fail('not_found', `No entity "${body.key}".`)

    const resolve = async (keys: string[]) => {
      if (keys.length === 0) return []
      const { data } = await admin()
        .from('projects')
        .select('id, key')
        .eq('owner_user_id', actor.userId)
        .in('key', keys.map((k) => k.toUpperCase()))
      return (data ?? []).map((p) => p.id as string)
    }

    if (body.title !== undefined || body.description !== undefined) {
      const fields: Record<string, string> = {}
      if (body.title !== undefined) fields.title = body.title
      if (body.description !== undefined) fields.description = body.description

      const { error } = await admin().from('entities').update(fields).eq('id', entity.id)
      if (error) return fail('internal_error', error.message)
    }

    const add = await resolve(body.addProjects)
    const remove = await resolve(body.removeProjects)

    if (add.length > 0) {
      const { error } = await admin()
        .from('project_entities')
        .upsert(add.map((project_id) => ({ project_id, entity_id: entity.id })))
      if (error) return fail('internal_error', error.message)
    }

    if (remove.length > 0) {
      const { error } = await admin()
        .from('project_entities')
        .delete()
        .eq('entity_id', entity.id)
        .in('project_id', remove)
      if (error) return fail('internal_error', error.message)
    }

    return ok({ key: body.key, added: add.length, removed: remove.length })
  },
})

/**
 * Deleting an entity drops its project links and unscopes any knowledge that
 * was filed against it — which is a widening, not a loss: those facts become
 * global rather than disappearing. Said plainly in the response so the caller
 * can tell the difference.
 */
export const DELETE = route({
  handler: async ({ actor, url }) => {
    const key = url.searchParams.get('key')
    if (!key) return fail('validation_failed', 'Provide ?key=<entity>.')

    const { data: entity } = await admin()
      .from('entities')
      .select('id')
      .eq('owner_user_id', actor.userId)
      .eq('key', key.toLowerCase())
      .maybeSingle()
    if (!entity) return fail('not_found', `No entity "${key}".`)

    const [{ count: projects }, { count: knowledge }] = await Promise.all([
      admin()
        .from('project_entities')
        .select('project_id', { count: 'exact', head: true })
        .eq('entity_id', entity.id),
      admin()
        .from('knowledge_entities')
        .select('knowledge_id', { count: 'exact', head: true })
        .eq('entity_id', entity.id),
    ])

    const { error } = await admin()
      .from('entities')
      .delete()
      .eq('id', entity.id)
      .eq('owner_user_id', actor.userId)
    if (error) return fail('internal_error', error.message)

    return ok({
      deleted: key,
      projectsUnlinked: projects ?? 0,
      knowledgeWidenedToGlobal: knowledge ?? 0,
    })
  },
})
