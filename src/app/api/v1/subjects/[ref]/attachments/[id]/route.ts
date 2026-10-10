import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { deleteSubjectFile } from '@/lib/api/subject-extras'

export const dynamic = 'force-dynamic'

export const DELETE = route<{ ref: string; id: string }>({
  handler: async ({ params }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const deleted = await deleteSubjectFile(found.subject.id, params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})
