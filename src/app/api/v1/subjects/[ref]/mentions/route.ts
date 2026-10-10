import { route } from '@/lib/api/handler'
import { failValidation, ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { mentionsQuery } from '@/lib/api/lab-schemas'
import { subjectMentions } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/** The tasks whose text names this subject, newest first. */
export const GET = route<{ ref: string }>({
  handler: async ({ params, url }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const parsed = mentionsQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return failValidation(parsed.error.issues)
    return ok(await subjectMentions(found.subject, parsed.data.limit))
  },
})
