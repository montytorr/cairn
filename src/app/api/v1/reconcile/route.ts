import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { reconcileClaims } from '@/lib/api/reconcile'

export const dynamic = 'force-dynamic'

const reconcileBody = z.object({
  olderThanMinutes: z.number().int().min(5).max(1440).optional(),
  dryRun: z.boolean().default(false),
})

/**
 * Releases this agent's own abandoned claims. Never anyone else's, and never
 * closes anything — an unresolved task that looks answered is worse than one
 * that is plainly still open.
 */
export const POST = route({
  schema: reconcileBody,
  handler: async ({ actor, body }) => ok(await reconcileClaims(actor, body)),
})
