import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createTag, listTags, refuseNonAdmin } from '@/lib/api/lab-admin'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { createTagSchema } from '@/lib/api/lab-schemas'

export const dynamic = 'force-dynamic'

export const GET = route({
  handler: async () => (await refuseLabDisabled()) ?? ok(await listTags()),
})

/** Adds a tag. Administrators only: tags are curated, not free-typed. */
export const POST = route<Record<string, string>, z.infer<typeof createTagSchema>>({
  schema: createTagSchema,
  handler: async ({ actor, body }) => {
    const refused = (await refuseLabDisabled()) ?? refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const created = await createTag(body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})
