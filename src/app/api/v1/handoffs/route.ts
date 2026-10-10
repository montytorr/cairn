import { route } from '@/lib/api/handler'
import { fail, failValidation, ok } from '@/lib/api/response'
import { listHandoffs } from '@/lib/api/handoff'
import { listHandoffsQuery } from '@/lib/api/lab-schemas'
import { resolveProject } from '@/lib/api/project-keys'

export const dynamic = 'force-dynamic'

/** What `cairn sync` walks: tasks handed off to another tracker, open ones by default. */
export const GET = route({
  handler: async ({ url }) => {
    const parsed = listHandoffsQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return failValidation(parsed.error.issues)
    let projectId: string | undefined
    if (parsed.data.project) {
      const found = await resolveProject(parsed.data.project)
      if (!found) return fail('not_found', `No project ${parsed.data.project}.`)
      projectId = found.project.id
    }
    return ok(
      await listHandoffs({
        state: parsed.data.state,
        tracker: parsed.data.tracker?.toLowerCase(),
        projectId,
        limit: parsed.data.limit,
      }),
    )
  },
})
