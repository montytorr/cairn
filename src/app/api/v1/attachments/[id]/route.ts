import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { BUCKET, signUrls } from '@/lib/attachments'

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
    | { id: string; original_name: string; storage_path: string }
    | null
}

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const row = await findOwned(actor.userId, params.id)
    if (!row) return fail('not_found', 'No such attachment.')
    return ok({ ...row, ...(await signUrls(row.storage_path, row.original_name)) })
  },
})

export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const row = await findOwned(actor.userId, params.id)
    if (!row) return fail('not_found', 'No such attachment.')

    // Object first: a failed row delete leaves a recoverable inconsistency,
    // whereas a deleted row with a live object is an unreferenced leak.
    const removed = await admin().storage.from(BUCKET).remove([row.storage_path])
    if (removed.error) return fail('internal_error', `Storage delete failed: ${removed.error.message}`)

    const { error } = await admin().from('task_attachments').delete().eq('id', row.id)
    if (error) return fail('internal_error', error.message)

    return ok({ deleted: true, id: row.id })
  },
})
