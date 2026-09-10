import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const createComment = z.object({ content: z.string().min(1).max(100_000) })

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('task_comments')
      .select('id, content, comment_type, actor_type, actor_id, created_at')
      .eq('task_id', task.id)
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})

/** Conversation aimed at the human. Findings and dead ends belong in notes. */
export const POST = route<{ ref: string }, z.infer<typeof createComment>>({
  schema: createComment,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('task_comments')
      .insert({
        task_id: task.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        content: body.content,
      })
      .select('id, content, created_at')
      .single()

    if (error) return fail('internal_error', error.message)
    return ok(data, { status: 201 })
  },
})
