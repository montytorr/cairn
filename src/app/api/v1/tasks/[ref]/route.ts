import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/supabase/admin'
import { findTask } from '@/lib/api/tasks'
import { isTerminal, updateTaskSchema, RESOLUTION_KINDS } from '@/schemas/task'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    return ok(task)
  },
})

/**
 * Offers the agent something to close with when it forgets a resolution.
 * Prefers the last checkpoint (the freshest statement of where things stood),
 * then the most recent `finding` note.
 */
const suggestResolution = async (taskId: string, checkpoint: unknown) => {
  if (typeof checkpoint === 'string' && checkpoint.trim()) return checkpoint

  const { data } = await admin()
    .from('task_notes')
    .select('note')
    .eq('task_id', taskId)
    .in('kind', ['finding', 'decision'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data?.note ?? null
}

export const PATCH = route<{ ref: string }, z.infer<typeof updateTaskSchema>>({
  schema: updateTaskSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const nextStatus = body.status ?? (task.status as string)
    const existingResolution = task.resolution as string | null

    // The rule that makes closed tasks worth finding later: you cannot close
    // a task without saying how it ended. Enforced here rather than as a DB
    // constraint, so imports and admin fixes remain possible.
    if (isTerminal(nextStatus as never) && !body.resolution && !existingResolution) {
      const suggestion = await suggestResolution(task.id, task.checkpoint_summary)
      return fail(
        'resolution_required',
        `Closing a task requires a resolution — what was actually done, and why. ` +
          `Pass "resolution" (and optionally "resolutionKind": ${RESOLUTION_KINDS.join(' | ')}).`,
        suggestion ? { suggestedResolution: suggestion } : undefined,
      )
    }

    const patch: Record<string, unknown> = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined) patch.description = body.description
    if (body.type !== undefined) patch.type = body.type
    if (body.status !== undefined) patch.status = body.status
    if (body.priority !== undefined) patch.priority = body.priority
    if (body.labels !== undefined) patch.labels = body.labels
    if (body.dueDate !== undefined) patch.due_date = body.dueDate
    if (body.resolutionKind !== undefined) patch.resolution_kind = body.resolutionKind

    if (body.resolution !== undefined) {
      patch.resolution = body.resolution
      patch.resolved_at = new Date().toISOString()
      patch.resolved_by = actor.actorId
      if (!body.resolutionKind && !task.resolution_kind) patch.resolution_kind = 'fixed'
    }

    if (Object.keys(patch).length === 0) {
      return fail('validation_failed', 'No fields to update.')
    }

    const { data, error } = await admin()
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .select('id, number, title, type, status, priority, labels, resolution, resolution_kind, updated_at')
      .single()

    if (error) return failFromDb(error)

    if (body.status && body.status !== task.status) {
      await admin().from('task_activity_events').insert({
        task_id: task.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'status_changed',
        data: { from: task.status, to: body.status },
      })
    }

    return ok(data)
  },
})

export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { error } = await admin().from('tasks').delete().eq('id', task.id)
    if (error) return failFromDb(error)
    return ok({ deleted: true, id: task.id })
  },
})
