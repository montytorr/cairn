import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { diffTaskEvents, recordActivity } from '@/lib/api/activity'
import { findTask, noSuchTaskMessage, renameFields, resolveParent, resolveTask } from '@/lib/api/tasks'
import { formerKeysByProject, formerRefsOf, projectsForKeys, resolveProject } from '@/lib/api/project-keys'
import { buildDigest } from '@/lib/api/digest'
import { mentionsOf } from '@/lib/api/mentions'
import { removeAttachments } from '@/lib/attachments'
import { isTerminal, updateTaskSchema, RESOLUTION_KINDS } from '@/schemas/task'

export const dynamic = 'force-dynamic'

/**
 * One task, and — when the ref went through a key the project used to have —
 * how it was reached.
 *
 * `requested_ref` and `renamed_from` appear only then. AC-113 answered with
 * HOL-113 and nothing else, and an agent whose commit message said AC-113 had
 * no way to tell it had the same task (CAIRN-264). `former_refs` lists the refs
 * this task was actually issued under, which excludes keys retired before the
 * task existed.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const resolved = await resolveTask(actor, params.ref)
    const { task } = resolved
    if (!task) return fail('not_found', noSuchTaskMessage(params.ref, resolved), renameFields(resolved))

    const formerKeys = (await formerKeysByProject([String(task.project_id)])).get(String(task.project_id)) ?? []
    const former_refs = formerRefsOf(
      { number: task.number as number, created_at: task.created_at as string | null },
      formerKeys,
    )
    const told = { ...renameFields(resolved), ...(former_refs.length > 0 ? { former_refs } : {}) }

    // `full` stays the default so nothing already calling this changes
    // behaviour. The CLI asks for the digest explicitly.
    if (url.searchParams.get('view') === 'digest') {
      return ok({ ...(await buildDigest(task)), ...told })
    }
    const mentioned = await mentionsOf(task.id as string, 50)
    return ok({ ...task, ...told, mentioned_in: mentioned.mentions, mentioned_in_total: mentioned.total })
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
  secretFields: ['title', 'description', 'resolution'],
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

    /**
     * And the other half of the same rule: a resolution is the statement
     * "this is settled, and here is how", so writing one without closing is a
     * contradiction the store cannot represent honestly.
     *
     * It was accepted silently. An agent wrote the answer, believed it had
     * finished, and the task sat in backlog carrying an answered dot — which
     * also offers it to `check` as settled prior work, the failure CAIRN-120
     * found on OD-36. Refused rather than auto-closed, because `done` and
     * `cancelled` are different claims about the work and only the caller
     * knows which one it is making.
     */
    if (body.resolution !== undefined && body.resolution !== null && !isTerminal(nextStatus as never)) {
      return fail(
        'validation_failed',
        `A resolution says a task is settled, so it cannot be written while ${params.ref} is ` +
          `"${nextStatus}". Send a terminal status with it — "done" if it was, "cancelled" if ` +
          `it will not be — or record it as a note instead if the work is still open.`,
        { status: nextStatus, terminal: ['done', 'cancelled'] },
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
      // The session goes with the claim. Left behind, it answers "which
      // session holds this" with one that finished the work and moved on.
      patch.claimed_session = null
      patch.claimed_at = null
      patch.heartbeat_at = null
    }

    /**
     * Reopening drops the answer with it.
     *
     * A resolution is the claim "this is settled, and here is how" — so a task
     * that is open again while still carrying one is lying twice: the list
     * shows its answered dot, and `check` offers it as prior work that was
     * resolved. OD-36 sat in backlog for two days carrying a resolution about
     * an entirely different task, because an agent corrected a mis-filed close
     * by reverting the status and the API kept the text.
     *
     * The old text is not destroyed — it goes into the activity event, where
     * the history can still show what was withdrawn.
     */
    const reopening =
      body.status &&
      !isTerminal(body.status) &&
      isTerminal(task.status as never) &&
      body.resolution === undefined

    if (reopening) {
      patch.resolution = null
      patch.resolution_kind = null
      patch.resolved_at = null
      patch.resolved_by = null
    }

    // Moving happens before the field update so a failure here does not leave
    // half a change applied. It is its own operation, not a column: the
    // number comes from the target project's counter.
    let moved: { ref: string; from: string } | null = null
    if (body.project) {
      // Through a retired key too: moving work "to AC" means to the project
      // AC became, not "no such project".
      const target = (await resolveProject(body.project))?.project

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
      const requested = [...new Set((body.alsoProjects ?? []).map((k) => k.toUpperCase()))]

      // A retired key links the project it became, and is reported under its
      // live key so the response does not repeat the old one back as current.
      const { found, missing } = await projectsForKeys(requested)
      if (missing.length > 0) return fail('not_found', `No such project: ${missing.join(', ')}`)
      const byLive = new Map([...found.values()].map((p) => [p.key, p.id]))
      const keys = [...byLive.keys()]

      const { error: clearError } = await admin()
        .from('task_projects')
        .delete()
        .eq('task_id', task.id)
      if (clearError) return fail('internal_error', clearError.message)

      if (keys.length > 0) {
        const { error: linkError } = await admin()
          .from('task_projects')
          .insert(keys.map((k) => ({ task_id: task.id, project_id: byLive.get(k)! })))
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

    await recordActivity(diffTaskEvents(actor, task.id, task, patch), actor.userId, actor.host)

    // The withdrawn answer, kept where history can still show it.
    if (reopening && task.resolution) {
      await recordActivity([
        {
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId ?? 'unknown',
          event: 'resolution_withdrawn',
          data: {
            kind: task.resolution_kind ?? null,
            resolution: String(task.resolution).slice(0, 2000),
          },
        },
      ], actor.userId, actor.host)
    }

    return ok(alsoProjects ? { ...data, alsoProjects } : data)
  },
})

/**
 * Deletes a task, and is deliberately hard to reach.
 *
 * This used to take a ref and delete it — no confirmation, and no objection to
 * a task carrying children, a work log or dependants. In a store whose whole
 * value is that things do not quietly vanish, the unguarded version was worse
 * than having none: `cancel` is what almost every caller reaching for this
 * actually wants, because it keeps the record and the reason.
 *
 * So this is for junk that should never have existed — a scratch task, a batch
 * filed by a broken import — and it refuses anything that has accumulated
 * meaning. What it refuses can still be deleted, by detaching or deleting the
 * things that depend on it first, which is the point: that is a decision per
 * item rather than one cascade nobody reviewed.
 */
// Counting on the filter column rather than `id`: task_deps is a composite
// key and has no id, so asking for one returns an error and a count of zero —
// a guard that reports "nothing depends on this" for every task alike.
const countForOthers = async (table: string, taskId: string, actorId: string) => {
  const { count, error } = await admin()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
    .neq('actor_id', actorId)
  if (error) throw new Error(`${table} count failed: ${error.message}`)
  return count ?? 0
}

const countFor = async (table: string, column: string, id: string) => {
  const { count, error } = await admin()
    .from(table)
    .select(column, { count: 'exact', head: true })
    .eq(column, id)
  if (error) throw new Error(`${table}.${column} count failed: ${error.message}`)
  return count ?? 0
}

export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const ref = `${(task.project as { key: string } | undefined)?.key ?? ''}-${task.number as number}`

    // Notes and comments the CALLER did not write. Its own are not a history
    // worth protecting from it: a scratch task that had acquired a single note
    // of its author's own became permanently undeletable, because delete
    // refused a work log and nothing could remove one. That left junk no
    // mechanism could clear, which is worse than the friction was worth.
    const [children, notes, comments, dependants, dependencies] = await Promise.all([
      countFor('tasks', 'parent_id', task.id),
      countForOthers('task_notes', task.id, actor.actorId),
      countForOthers('task_comments', task.id, actor.actorId),
      // Both directions: something pointing AT this task loses its dependency
      // silently, which is the failure that is hardest to notice afterwards.
      countFor('task_deps', 'blocking_id', task.id),
      countFor('task_deps', 'blocked_id', task.id),
    ])

    const holding = [
      children && `${children} child task${children === 1 ? '' : 's'}`,
      notes && `${notes} work-log note${notes === 1 ? '' : 's'} from somebody else`,
      comments && `${comments} comment${comments === 1 ? '' : 's'} from somebody else`,
      dependants && `${dependants} task${dependants === 1 ? '' : 's'} depending on it`,
      dependencies && `${dependencies} dependenc${dependencies === 1 ? 'y' : 'ies'} of its own`,
    ].filter(Boolean) as string[]

    if (holding.length > 0) {
      return fail(
        'validation_failed',
        `${ref} has ${holding.join(', ')}. Delete is for tasks that should never have ` +
          `existed; this one has a history. Cancel it instead — \`status: cancelled\` with a ` +
          `resolution keeps the record and the reason — or detach what it holds first.`,
        { holding, children, notes, comments, dependants, dependencies },
      )
    }

    if (url.searchParams.get('confirm') !== ref) {
      return fail(
        'validation_failed',
        `This permanently deletes ${ref} and cannot be undone. Repeat the ref to ` +
          `confirm: ?confirm=${ref}`,
        { requiresConfirmation: ref },
      )
    }

    // Storage objects are outside the database cascade, so they have to go
    // explicitly or the bucket keeps orphans nobody can find a task for.
    const { data: files } = await admin()
      .from('task_attachments')
      .select('storage_path')
      .eq('task_id', task.id)
    const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path)
    if (paths.length > 0) await removeAttachments(paths)

    /**
     * The tombstone, written BEFORE the delete.
     *
     * task_id detaches rather than cascading now, so this row survives — but
     * only if it exists first. Written after the delete it would have no task
     * to hang from and the ref would already be unrecoverable. The ref and
     * title go into `data` for the same reason: once the row is gone they are
     * the only record of what was removed.
     */
    await recordActivity([
      {
        task_id: task.id,
        project_id: (task.project_id as string) ?? null,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'task_deleted',
        data: { ref, title: String(task.title ?? '').slice(0, 200) },
      },
    ], actor.userId, actor.host)

    /**
     * Every event this task leaves behind gets its ref, while the ref is still
     * knowable.
     *
     * task_id detaches on delete, so the rows survive — but the feed resolves a
     * name through the task, and a detached row had nothing to show but the
     * project key. Stamping it now is the last moment anything can.
     */
    await admin().rpc('cairn_stamp_ref', { p_task: task.id, p_ref: ref })

    const { error } = await admin().from('tasks').delete().eq('id', task.id)
    if (error) return failFromDb(error)
    return ok({ deleted: true, ref, id: task.id, attachmentsRemoved: paths.length })
  },
})
