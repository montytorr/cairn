import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { deleteStage, refuseNonAdmin, updateStage } from '@/lib/api/lab-admin'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { updateStageSchema } from '@/lib/api/lab-schemas'

export const dynamic = 'force-dynamic'

export const PATCH = route<{ id: string }, z.infer<typeof updateStageSchema>>({
  schema: updateStageSchema,
  handler: async ({ actor, params, body }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const updated = await updateStage(params.id, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/** Refused with `stage_in_use` while any subject, archived or not, is in it. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const deleted = await deleteStage(params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})
