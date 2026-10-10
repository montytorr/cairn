import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { refuseNonAdmin, reorderStages } from '@/lib/api/lab-admin'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { reorderSchema } from '@/lib/api/lab-schemas'

export const dynamic = 'force-dynamic'

/** Every stage id exactly once; the order given becomes the board's order. */
export const POST = route<Record<string, string>, z.infer<typeof reorderSchema>>({
  schema: reorderSchema,
  handler: async ({ actor, body }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const reordered = await reorderStages(body.ids)
    return reordered.ok ? ok(reordered.value) : reordered.response
  },
})
