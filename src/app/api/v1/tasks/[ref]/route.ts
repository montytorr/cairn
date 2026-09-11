import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/supabase/admin'
import { diffTaskEvents, recordActivity } from '@/lib/api/activity'
import { findTask, resolveParent } from '@/lib/api/tasks'
import { buildDigest } from '@/lib/api/digest'
import { isTerminal, updateTaskSchema, RESOLUTION_KINDS } from '@/schemas/task'

export const dynamic = 'force-dynamic'

/**
 * PostgREST rejects a malformed uuid in an `or` filter outright, so a project
 * *key* would break the lookup. Substituting a nil uuid keeps the clause
 * well-formed and simply never matches.
 */
const UUID_OR_NULL = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '00000000-0000-0000-0000-000000000000'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    // `full` stays the default so nothing already calling this changes
    // behaviour. The CLI asks for the digest explicitly.
    if (url.searchParams.get('view') === 'digest') {
      return ok(await buildDigest(task))
    }
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

    if (body.parentRef !== undefined) {
      if (body.parentRef === null) {
        patch.parent_id = null
      } else {
        const parent = await resolveParent(actor, task.id, body.parentRef)
        if ('error' in parent) return fail('validation_failed', parent.error)
        patch.parent_id = parent.id
      }
    }

    if (body.duplicateOf !== undefined) {
      if (body.duplicateOf === null) {
        patch.duplicate_of = null
      } else {
        const original = await findTask(actor, body.duplicateOf, 'id, number, title')
        if (!original) return fail('not_found', `No task ${body.duplicateOf}.`)
        if (original.id === task.id) {
          return fail('validation_failed', 'A task cannot duplicate itself.')
        }
        patch.duplicate_of = original.id
        // Naming the original is the whole point, so treat it as the caller
        // saying "duplicate" even if they only sent the pointer. The database
        // refuses the pointer without the kind, and failing on a technicality
        // here would be unhelpful.
        if (!body.resolutionKind && task.resolution_kind !== 'duplicate') {
          patch.resolution_kind = 'duplicate'
        }
      }
    }

    // Finishing a task releases it. Without this the claim outlives the work,
    // and a board where done tasks still show a holder makes the one field an
    // agent checks before picking something up untrustworthy.
    if (body.status && isTerminal(body.status) && task.claimed_by) {
      patch.claimed_by = null
      patch.claimed_at = null
      patch.heartbeat_at = null
    }

    // Moving happens before the field update so a failure here does not leave
    // half a change applied. It is its own operation, not a column: the
    // number comes from the target project's counter.
    let moved: { ref: string; from: string } | null = null
    if (body.project) {
      const { data: target } = await admin()
        .from('projects')
        .select('id, key')
        .eq('owner_user_id', actor.userId)
        .or(`key.eq.${body.project.toUpperCase()},id.eq.${UUID_OR_NULL(body.project)}`)
        .maybeSingle()

      if (!target) return fail('not_found', `No project ${body.project}.`)

      const current = task.project as { key?: string } | { key?: string }[] | undefined
      const from = (Array.isArray(current) ? current[0] : current)?.key ?? ''

      if (target.id !== (task.project_id ?? null) && from !== target.key) {
        const { data: result, error: moveError } = await admin().rpc('move_task', {
          p_owner: actor.userId,
          p_task: task.id,
          p_project: target.id,
        })
        if (moveError) return fail('internal_error', moveError.message)
        const row = (result as { number: number; project_key: string }[] | null)?.[0]
        if (row) moved = { ref: `${row.project_key}-${row.number}`, from }
      }
    }

    // Secondary project links. Replaced wholesale, because an explicit list is
    // a statement about where this work belongs, not an addition to it.
    let alsoProjects: string[] | null = null
    if (body.alsoProjects !== undefined) {
      const keys = [...new Set((body.alsoProjects ?? []).map((k) => k.toUpperCase()))]

      const { data: targets, error: lookupError } = await admin()
        .from('projects')
        .select('id, key')
        .eq('owner_user_id', actor.userId)
        .in('key', keys.length > 0 ? keys : ['\u0000'])
      if (lookupError) return fail('internal_error', lookupError.message)

      const found = new Map((targets ?? []).map((p) => [p.key as string, p.id as string]))
      const missing = keys.filter((k) => !found.has(k))
      if (missing.length > 0) return fail('not_found', `No such project: ${missing.join(', ')}`)

      const { error: clearError } = await admin()
        .from('task_projects')
        .delete()
        .eq('task_id', task.id)
      if (clearError) return fail('internal_error', clearError.message)

      if (keys.length > 0) {
        const { error: linkError } = await admin()
          .from('task_projects')
          .insert(keys.map((k) => ({ task_id: task.id, project_id: found.get(k)! })))
        if (linkError) {
          // The trigger refuses a link to the task's own home project, which
          // would list it twice in one place.
          return fail('validation_failed', linkError.message)
        }
      }
      alsoProjects = keys
    }

    if (Object.keys(patch).length === 0) {
      if (alsoProjects) return ok({ ...task, alsoProjects })
      if (moved) {
        return ok({
          ...task,
          ref: moved.ref,
          moved,
          note: `Ref changed from ${moved.from}-${task.number} to ${moved.ref}; anything referring to the old one is now stale.`,
        })
      }
      return fail('validation_failed', 'No fields to update.')
    }

    const { data, error } = await admin()
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .select('id, number, title, type, status, priority, labels, resolution, resolution_kind, updated_at')
      .single()

    if (error) {
      return failFromDb(error, {
        // The database refuses a duplicate pointer without the matching kind,
        // which is otherwise a bare constraint name in the response.
        '23514': error.message.includes('tasks_duplicate_needs_kind')
          ? 'A duplicate pointer only makes sense with resolutionKind "duplicate". Send both, or send duplicateOf: null.'
          : error.message,
      })
    }

    await recordActivity(diffTaskEvents(actor, task.id, task, patch))

    return ok(alsoProjects ? { ...data, alsoProjects } : data)
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
