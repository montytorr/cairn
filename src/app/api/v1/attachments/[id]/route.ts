import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { removeAttachments, signUrls } from '@/lib/attachments'

export const dynamic = 'force-dynamic'

/** Attachments are reachable only through a task the caller owns. */
const findOwned = async (userId: string, id: string) => {
  const { data } = await admin()
    .from('task_attachments')
    .select(
      'id, original_name, mime_type, size_bytes, sha256, storage_path, created_at, ' +
        'task:tasks!inner(id, project:projects!project_id!inner(owner_user_id))',
    )
    .eq('id', id)
    .eq('tasks.projects.owner_user_id', userId)
    .maybeSingle()
  return data as unknown as
    | { id: string; original_name: string; mime_type: string; storage_path: string }
    | null
}

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const row = await findOwned(actor.userId, params.id)
    if (!row) return fail('not_found', 'No such attachment.')
    return ok({ ...row, ...(await signUrls(row.storage_path, row.original_name, row.mime_type)) })
  },
})

export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const row = await findOwned(actor.userId, params.id)
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

    return ok({ deleted: true, id: row.id })
  },
})
