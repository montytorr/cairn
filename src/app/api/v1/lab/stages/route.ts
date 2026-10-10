import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createStage, listStages, refuseNonAdmin } from '@/lib/api/lab-admin'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { createStageSchema } from '@/lib/api/lab-schemas'

export const dynamic = 'force-dynamic'

export const GET = route({
  handler: async () => (await refuseLabDisabled()) ?? ok(await listStages()),
})

/** Adds a stage. Administrators only; without `position` it goes last. */
export const POST = route<Record<string, string>, z.infer<typeof createStageSchema>>({
  schema: createStageSchema,
  handler: async ({ actor, body }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const created = await createStage(body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})
