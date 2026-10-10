import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { deleteTag, refuseNonAdmin, updateTag } from '@/lib/api/lab-admin'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { updateTagSchema } from '@/lib/api/lab-schemas'

export const dynamic = 'force-dynamic'

export const PATCH = route<{ id: string }, z.infer<typeof updateTagSchema>>({
  schema: updateTagSchema,
  handler: async ({ actor, params, body }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const updated = await updateTag(params.id, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/** Takes the tag off every subject; the subjects themselves are untouched. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const deleted = await deleteTag(params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})
