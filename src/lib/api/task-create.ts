import type { z } from 'zod'
import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { failFromDb } from './db-errors'
import { resolveAssignee, withAssignee } from './people'
import { fail } from './response'
import { refuseUnreadableBody } from './task-body'
import { findTask } from './tasks'
import type { createTaskSchema } from '@/schemas/task'

/**
 * The one path a task is filed by: the project route and a subject's todos
 * (docs/lab.md) both come through here, so a todo is a task in every respect
 * but its subject — the same body rule, numbering, idempotent external ref
 * and `created` event.
 */

export type CreateTaskBody = z.infer<typeof createTaskSchema>
type Project = { id: string; key: string; status: string }

export const CREATED_FIELDS =
  'id, number, title, type, status, priority, labels, assignee_user_id, external_ref, external_url, subject_id, created_at'

/** The task already carrying an external ref, wherever it is filed. */
const holderOf = async (externalRef: string) => {
  const { data } = await admin()
    .from('tasks')
    .select(`${CREATED_FIELDS}, project:projects!project_id!inner(key)`)
    .eq('external_ref', externalRef)
    .maybeSingle()
  if (!data) return null
  const { project, ...task } = data as unknown as { number: number; project: { key: string } | { key: string }[] }
  const key = (Array.isArray(project) ? project[0] : project)?.key
  return { ...(await withAssignee(task)), ref: `${key}-${task.number}` }
}

export type CreateTaskOutcome =
  | { ok: true; task: Record<string, unknown> & { id: string; ref: string }; duplicate: boolean }
  | { ok: false; response: Response }

export const archivedProjectRefusal = (project: Project) =>
  fail(
    'conflict',
    `${project.key} is archived — most likely because it moved to another Cairn instance and ` +
      `this is the copy left behind. If it moved, point the CLI at the other one with ` +
      `--instance <the other instance>. To file work here instead, restore ${project.key} first: ` +
      `\`cairn project restore ${project.key}\`.`,
    { project: project.key, projectStatus: 'archived' },
  )

export const createTaskInProject = async (
  actor: Actor,
  project: Project,
  body: CreateTaskBody,
  options: {
    /** The subject the task is a todo of. Undefined: inherited from the parent, if it has one. */
    subjectId?: string | null
    /** The command to suggest when the body is refused as unreadable. */
    retry: string
  },
): Promise<CreateTaskOutcome> => {
  // Same rule as writing to an existing task (F1): a project archived here
  // is most likely the copy a move to another instance left behind, and a
  // stale-cached CLI filing a new task into it would strand the task the
  // same way a claim or a note would.
  if (project.status === 'archived') return { ok: false, response: archivedProjectRefusal(project) }

  const unreadable = refuseUnreadableBody(actor, body.description, options.retry)
  if (unreadable) return { ok: false, response: unreadable }

  // Idempotent on the external ref, as a note is on its content: a caller
  // that retries after a timeout, or files the same upstream item twice,
  // gets the task it already made. Instance-wide, because the index is.
  if (body.externalRef) {
    const existing = await holderOf(body.externalRef)
    if (existing) return { ok: true, task: existing as typeof existing & { id: string }, duplicate: true }
  }

  // A new task has no id yet, so it cannot be its own ancestor — the cycle
  // walk that re-parenting needs is unnecessary here.
  let parentId: string | null = null
  let subjectId = options.subjectId
  if (body.parentRef) {
    const parent = await findTask(actor, body.parentRef, 'id, subject_id')
    if (!parent) return { ok: false, response: fail('not_found', `No task ${body.parentRef}.`) }
    parentId = parent.id
    // A sub-task of a todo is part of the same subject's work.
    if (subjectId === undefined) subjectId = (parent.subject_id as string | null) ?? null
  }

  const owner = await resolveAssignee(body.assignee ?? 'me', actor.userId)
  if (!owner.ok) return { ok: false, response: fail(owner.code, owner.error) }

  const { data, error } = await admin()
    .from('tasks')
    .insert({
      project_id: project.id,
      parent_id: parentId,
      title: body.title,
      description: body.description ?? null,
      type: body.type,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      due_date: body.dueDate ?? null,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      assignee_user_id: owner.person.id,
      external_ref: body.externalRef ?? null,
      external_url: body.externalUrl ?? null,
      subject_id: subjectId ?? null,
    })
    .select(CREATED_FIELDS)
    .single()

  // Two creates racing past the lookup: the loser meets the unique index and
  // gets the winner, which is what the lookup would have said a moment later.
  if (error && body.externalRef && error.code === '23505' && error.message.includes('tasks_external_ref_key')) {
    const winner = await holderOf(body.externalRef)
    if (winner) return { ok: true, task: winner as typeof winner & { id: string }, duplicate: true }
  }
  if (error) return { ok: false, response: failFromDb(error) }

  await admin().from('task_activity_events').insert({
    owner_user_id: actor.userId,
    project_id: project.id,
    task_id: data.id,
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    event: 'created',
    data: { type: body.type, status: body.status, assignee: owner.person.name, ...(actor.host ? { host: actor.host } : {}) },
  })

  return {
    ok: true,
    task: { ...(data as Record<string, unknown> & { id: string }), assignee: owner.person, ref: `${project.key}-${data.number}` },
    duplicate: false,
  }
}
