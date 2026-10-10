import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { canAdministerUsers } from '@/lib/api/actor'
import { getLabSettings, projectHoldingLabKey, writeLabSettings } from '@/lib/api/lab-settings'
import { labSettingsSchema } from '@/lib/api/lab-schemas'
import { resolveProject } from '@/lib/api/project-keys'
import { LAB_KEY } from '@/lib/api/lab-shape'

export const dynamic = 'force-dynamic'

/** Whether the Lab is on, and its home project. Anyone signed in; answers whether it is on or off. */
export const GET = route({ handler: async () => ok(await getLabSettings()) })

/**
 * Turns the Lab on or off, and chooses the todo home project. A human
 * administrator only, as branding is: it changes what every user sees.
 */
export const PUT = route<Record<string, string>, z.infer<typeof labSettingsSchema>>({
  schema: labSettingsSchema,
  handler: async ({ actor, body }) => {
    if (!canAdministerUsers(actor)) {
      return fail('forbidden', 'Only an administrator, signed in, can turn the Lab on or off.')
    }

    if (body.enabled) {
      // LAB-12 must mean one thing: a project keyed LAB is rekeyed first.
      const holder = await projectHoldingLabKey()
      if (holder) {
        return fail(
          'conflict',
          `A project ${holder.key === LAB_KEY ? 'is keyed' : `(${holder.key}) used to be keyed`} ${LAB_KEY}, which Lab ` +
            `subjects need for their refs. Rekey it first, then turn the Lab on.`,
          { project: holder.key, project_id: holder.id },
        )
      }
    }

    let homeProjectId: string | null | undefined
    if (body.homeProject !== undefined) {
      if (body.homeProject === null) {
        homeProjectId = null
      } else {
        const found = await resolveProject<{ id: string; key: string; status: string }>(body.homeProject, 'id, key, status')
        if (!found) return fail('validation_failed', `No project ${body.homeProject}.`, { field: 'homeProject' })
        if (found.project.status === 'archived') {
          return fail('validation_failed', `${found.project.key} is archived.`, { field: 'homeProject' })
        }
        homeProjectId = found.project.id
      }
    }

    return ok(await writeLabSettings(actor, { enabled: body.enabled, homeProjectId }))
  },
})
