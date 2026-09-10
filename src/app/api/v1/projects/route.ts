import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const createProject = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'key must be 2-10 uppercase alphanumerics, e.g. CAI'),
  title: z.string().min(1).max(200),
  description: z.string().max(100_000).optional(),
})

export const GET = route({
  handler: async ({ actor }) => {
    const { data, error } = await admin()
      .from('projects')
      .select('id, key, title, description, status, task_counter, created_at, updated_at')
      .eq('owner_user_id', actor.userId)
      .order('position')
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(data)
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

    if (error) {
      return failFromDb(error, { '23505': `A project with key ${body.key} already exists.` })
    }

    return ok(data, { status: 201 })
  },
})
