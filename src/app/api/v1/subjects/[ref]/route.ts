import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { updateSubjectSchema } from '@/lib/api/lab-schemas'
import { deleteSubject, updateSubject } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ params }) => {
    const found = await subjectForRoute(params.ref)
    return 'response' in found ? found.response : ok(found.subject)
  },
})

export const PATCH = route<{ ref: string }, z.infer<typeof updateSubjectSchema>>({
  schema: updateSubjectSchema,
  secretFields: ['title', 'body', 'conclusion'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const updated = await updateSubject(actor, found.subject, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/**
 * Deletes a subject; never its todos (docs/lab.md). `?confirm=LAB-12` is
 * required; a subject with todos is refused unless `todos=detach`.
 */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const { subject } = found

    const confirm = url.searchParams.get('confirm')?.trim().toUpperCase()
    if (confirm !== subject.ref) {
      return fail(
        'validation_failed',
        `Deleting ${subject.ref} needs ?confirm=${subject.ref}. Archiving keeps everything: PATCH {"archived": true}.`,
        { field: 'confirm' },
      )
    }
    const todos = url.searchParams.get('todos')
    if (todos !== null && todos !== 'detach') {
      return fail('validation_failed', 'todos may only be "detach": deleting a subject never deletes tasks.', { field: 'todos' })
    }

    const deleted = await deleteSubject(actor, subject, { detach: todos === 'detach' })
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})
