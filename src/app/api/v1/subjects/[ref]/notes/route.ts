import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { failValidation, ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { createSubjectNoteSchema, listSubjectNotesQuery } from '@/lib/api/lab-schemas'
import { addSubjectNote, listSubjectNotes } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/** The log, newest first. */
export const GET = route<{ ref: string }>({
  handler: async ({ params, url }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const parsed = listSubjectNotesQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return failValidation(parsed.error.issues)
    const kinds = parsed.data.kind?.split(',').map((k) => k.trim()).filter(Boolean)
    return ok(await listSubjectNotes(found.subject.id, { kinds, limit: parsed.data.limit }))
  },
})

/** Appends to the log. A retry of the same kind and text is one note (200, duplicate: true). */
export const POST = route<{ ref: string }, z.infer<typeof createSubjectNoteSchema>>({
  schema: createSubjectNoteSchema,
  secretFields: ['note'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const written = await addSubjectNote(actor, found.subject.id, body)
    if (written.duplicate) return ok({ duplicate: true, kind: body.kind, note: body.note }, { status: 200 })
    return ok(written.note, { status: 201 })
  },
})
