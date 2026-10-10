import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { humanNoteSchema } from '@/lib/api/lab-schemas'
import { addHumanNote, listHumanNotes } from '@/lib/api/subject-extras'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ params }) => {
    const found = await subjectForRoute(params.ref)
    return 'response' in found ? found.response : ok(await listHumanNotes(found.subject.id))
  },
})

export const POST = route<{ ref: string }, z.infer<typeof humanNoteSchema>>({
  schema: humanNoteSchema,
  secretFields: ['body'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    return ok(await addHumanNote(actor, found.subject.id, body.body), { status: 201 })
  },
})
