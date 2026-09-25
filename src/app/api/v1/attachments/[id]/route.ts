import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { recordActivity } from '@/lib/api/activity'
import { removeAttachments, signUrls } from '@/lib/attachments'

export const dynamic = 'force-dynamic'

/** Attachments are shared workspace data and remain reachable through their task. */
const findWorkspaceAttachment = async (id: string) => {
  const { data } = await admin()
    .from('task_attachments')
    .select(
      'id, original_name, mime_type, size_bytes, sha256, storage_path, created_at, ' +
        'task:tasks!inner(id, project:projects!project_id!inner(id))',
    )
    .eq('id', id)
    .maybeSingle()
  return data as unknown as
    | {
        id: string
        original_name: string
        mime_type: string
        storage_path: string
        // The embed is the only place the task id is available here, and the
        // activity row needs it to attach the removal to the right timeline.
        task?: { id: string } | { id: string }[] | null
      }
    | null
}

export const GET = route<{ id: string }>({
  handler: async ({ params }) => {
    const row = await findWorkspaceAttachment(params.id)
    if (!row) return fail('not_found', 'No such attachment.')
    return ok({ ...row, ...(await signUrls(row.storage_path, row.original_name, row.mime_type)) })
  },
})

export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const row = await findWorkspaceAttachment(params.id)
    if (!row) return fail('not_found', 'No such attachment.')

    // Object first: a failed row delete leaves a recoverable inconsistency,
    // whereas a deleted row with a live object is an unreferenced leak.
    try {
      await removeAttachments([row.storage_path])
    } catch (error) {
      return fail('internal_error', `Storage delete failed: ${error instanceof Error ? error.message : error}`)
    }

    const { error } = await admin().from('task_attachments').delete().eq('id', row.id)
    if (error) return fail('internal_error', error.message)

    await recordActivity([
      {
        task_id: (Array.isArray(row.task) ? row.task[0]?.id : row.task?.id) ?? null,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'attachment_removed',
        data: { name: row.original_name },
      },
    ], actor.userId, actor.host)

    return ok({ deleted: true, id: row.id })
  },
})
