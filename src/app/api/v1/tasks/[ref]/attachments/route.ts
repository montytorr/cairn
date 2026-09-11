import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask } from '@/lib/api/tasks'
import {
  buildStoragePath,
  sanitizeFilename,
  sha256,
  signUrls,
  validateUpload,
  writeAttachment,
  removeAttachments,
} from '@/lib/attachments'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('task_attachments')
      .select('id, original_name, mime_type, size_bytes, sha256, actor_id, created_at')
      .eq('task_id', task.id)
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})

/**
 * multipart/form-data upload. No Zod here — FormData is not JSON, so the
 * fields are validated by hand, which is why the route wrapper only applies a
 * schema when one is given.
 */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params, req }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) {
      return fail('validation_failed', 'Send multipart/form-data with a "file" field.')
    }

    const rejection = validateUpload({ name: file.name, type: file.type, size: file.size })
    if (rejection) {
      return fail('validation_failed', rejection.reason, rejection.valid ? { validTypes: rejection.valid } : undefined)
    }

    const projectId = (task.project as { id: string } | undefined)?.id
    if (!projectId) return fail('internal_error', 'Task is missing its project.')

    const bytes = Buffer.from(await file.arrayBuffer())
    const storagePath = buildStoragePath(projectId, task.id, file.name)

    try {
      await writeAttachment(storagePath, bytes)
    } catch (error) {
      return fail('internal_error', `Upload failed: ${error instanceof Error ? error.message : error}`)
    }

    const { data, error } = await admin()
      .from('task_attachments')
      .insert({
        task_id: task.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        filename: sanitizeFilename(file.name),
        original_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        storage_path: storagePath,
        sha256: sha256(bytes),
      })
      .select('id, original_name, mime_type, size_bytes, sha256, created_at')
      .single()

    if (error) {
      // Do not leave an orphan object behind if the row insert fails.
      await removeAttachments([storagePath])
      return fail('internal_error', error.message)
    }

    return ok({ ...data, ...(await signUrls(storagePath, file.name, file.type)) }, { status: 201 })
  },
})
