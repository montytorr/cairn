import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { humanNoteSchema } from '@/lib/api/lab-schemas'
import { deleteHumanNote, editHumanNote } from '@/lib/api/subject-extras'

export const dynamic = 'force-dynamic'

/** Its author only. */
export const PATCH = route<{ ref: string; id: string }, z.infer<typeof humanNoteSchema>>({
  schema: humanNoteSchema,
  secretFields: ['body'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const edited = await editHumanNote(actor, found.subject.id, params.id, body.body)
    return edited.ok ? ok(edited.value) : edited.response
  },
})

/** Its author or an administrator. */
export const DELETE = route<{ ref: string; id: string }>({
  handler: async ({ actor, params }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const deleted = await deleteHumanNote(actor, found.subject.id, params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})
