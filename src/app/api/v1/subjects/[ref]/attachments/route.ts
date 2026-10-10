import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { addSubjectFile, listSubjectFiles } from '@/lib/api/subject-extras'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ params }) => {
    const found = await subjectForRoute(params.ref)
    return 'response' in found ? found.response : ok(await listSubjectFiles(found.subject.id))
  },
})

/** multipart/form-data with a `file` field; the same limits as a task's files. */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params, req }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const added = await addSubjectFile(actor, found.subject.id, req)
    return added.ok ? ok(added.value, { status: 201 }) : added.response
  },
})
