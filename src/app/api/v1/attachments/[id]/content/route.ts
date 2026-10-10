import { route } from '@/lib/api/handler'
import { fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { signUrls } from '@/lib/attachments'
import { isLabEnabled } from '@/lib/api/lab-settings'
import { findSubjectFile } from '@/lib/api/subject-extras'
import { isUuid } from '@/lib/api/lab-admin'

export const dynamic = 'force-dynamic'

/**
 * The stable address of a file, a task's or a subject's, for markdown to
 * embed: `![shot](/api/v1/attachments/<id>/content)`. Signed links expire in
 * the hour, so a write-up cannot hold one; this authenticates the viewer and
 * redirects to a freshly signed preview, which /api/files serves with the
 * headers every file gets.
 *
 * The Location is relative: behind a TLS-terminating proxy the request URL
 * reads http://, and an absolute redirect built from it would downgrade.
 */
export const GET = route<{ id: string }>({
  handler: async ({ params }) => {
    if (!isUuid(params.id)) return fail('not_found', 'No such attachment.')

    const { data: taskFile } = await admin()
      .from('task_attachments')
      .select('storage_path, original_name, mime_type')
      .eq('id', params.id)
      .maybeSingle()
    const file = taskFile
      ? (taskFile as { storage_path: string; original_name: string; mime_type: string })
      : await (async () => {
          const row = (await isLabEnabled()) ? await findSubjectFile(params.id) : null
          return row ? { storage_path: row.storage_path, original_name: row.filename, mime_type: row.mime_type } : null
        })()
    if (!file) return fail('not_found', 'No such attachment.')

    const { previewUrl } = await signUrls(file.storage_path, file.original_name, file.mime_type)
    return new Response(null, {
      status: 302,
      headers: { location: previewUrl, 'cache-control': 'private, no-store' },
    })
  },
})
