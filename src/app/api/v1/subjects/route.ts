import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, failValidation, ok } from '@/lib/api/response'
import { refuseLabDisabled } from '@/lib/api/lab-settings'
import { createSubjectSchema, listSubjectsQuery } from '@/lib/api/lab-schemas'
import { resolveAssignee } from '@/lib/api/people'
import { createSubject, listSubjects, unknownListFilters } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/** The board, filtered. `category=planned` is the Ideas list. */
export const GET = route({
  handler: async ({ actor, url }) => {
    const disabled = await refuseLabDisabled()
    if (disabled) return disabled

    const parsed = listSubjectsQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return failValidation(parsed.error.issues)
    const { owner, ...filters } = parsed.data

    let ownerId: string | undefined
    if (owner) {
      const person = await resolveAssignee(owner, actor.userId)
      if (!person.ok) return fail('validation_failed', person.error, { field: 'owner' })
      ownerId = person.person.id
    }

    const unknown = await unknownListFilters(filters)
    if (unknown) return unknown
    return ok(await listSubjects({ ...filters, ownerId }))
  },
})

/** Files a subject. No stage: the first planned stage (`cairn idea`). */
export const POST = route<Record<string, string>, z.infer<typeof createSubjectSchema>>({
  schema: createSubjectSchema,
  secretFields: ['title', 'body', 'conclusion'],
  handler: async ({ actor, body }) => {
    const disabled = await refuseLabDisabled()
    if (disabled) return disabled
    const created = await createSubject(actor, body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})
