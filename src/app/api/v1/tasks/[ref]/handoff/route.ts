import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived, TASK_FIELDS } from '@/lib/api/tasks'
import { linkHandoff, unlinkHandoff } from '@/lib/api/handoff'
import { handoffOf, handoffUrlProblem } from '@/lib/api/lab-shape'
import { handoffSchema } from '@/lib/api/lab-schemas'
import { withAssignee } from '@/lib/api/people'

export const dynamic = 'force-dynamic'

const FOR_HANDOFF =
  'id, number, subject_id, handoff_tracker, handoff_ref, handoff_url, handoff_status, project:projects!project_id!inner(key, status)'

/**
 * Links a task to the task it became in another tracker, re-links it, or
 * syncs what that tracker says about it (same tracker and ref). A done or
 * cancelled status ends the hand-off: the task closes once with the outcome,
 * and a todo's subject log records it once.
 */
export const POST = route<{ ref: string }, z.infer<typeof handoffSchema>>({
  schema: handoffSchema,
  // The resolution is written to the task and to the subject's log, and the
  // ref and url into the task: the same guard PATCH applies.
  secretFields: ['ref', 'url', 'resolution'],
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, FOR_HANDOFF)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived
    const taskRef = refOfRow(task) ?? params.ref

    // A cairn link names its instance. A sync of a link that already has its
    // url may leave it out: the stored one is kept.
    const current = handoffOf(task)
    const sync = current?.tracker === body.tracker && current.ref === body.ref
    const problem = handoffUrlProblem(body.tracker, body.url ?? (sync ? current?.url : null))
    if (problem) return fail('validation_failed', problem, { field: 'url' })

    return ok(
      await linkHandoff(actor, { id: task.id, ref: taskRef }, {
        tracker: body.tracker,
        ref: body.ref,
        url: body.url,
        status: body.status,
        resolution: body.resolution,
        resolutionKind: body.resolutionKind,
      }),
    )
  },
})

/** Takes it back: clears the link. Nothing is done in the other tracker. Returns the task. */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, FOR_HANDOFF)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived
    const taskRef = refOfRow(task) ?? params.ref

    if (!(await unlinkHandoff(actor, { id: task.id, ref: taskRef }))) {
      return fail('conflict', `${taskRef} is not handed off.`)
    }
    const after = await findTask(actor, params.ref, TASK_FIELDS)
    if (!after) return fail('not_found', `No task ${params.ref}.`)
    return ok(await withAssignee(after))
  },
})
