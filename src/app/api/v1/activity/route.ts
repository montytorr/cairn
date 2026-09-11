import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { activityFeed } from '@/lib/api/activity-feed'

export const dynamic = 'force-dynamic'

const ACTIVITY_KINDS = ['task', 'event', 'note', 'comment', 'session', 'knowledge'] as const

const query = z.object({
  before: z.string().datetime().optional(),
  project: z.string().max(10).optional(),
  actor: z.string().max(80).optional(),
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * One timeline across every store. `before` is a keyset cursor, not an offset:
 * the feed grows from the head, so an offset page drifts under the reader as
 * soon as an agent writes anything.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = query.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) {
      return fail('validation_failed', 'Bad filters.', { issues: parsed.error.issues })
    }

    const bad = parsed.data.kinds?.filter(
      (k) => !(ACTIVITY_KINDS as readonly string[]).includes(k),
    )
    if (bad?.length) {
      return fail('validation_failed', `Unknown kind: ${bad.join(', ')}`, {
        valid: ACTIVITY_KINDS,
      })
    }

    const rows = await activityFeed(actor.userId, parsed.data)

    return ok({
      count: rows.length,
      // The caller pages by asking for what happened before the oldest row it
      // has, so hand that back rather than making it dig for it.
      nextBefore: rows.length === parsed.data.limit ? rows.at(-1)?.at : null,
      results: rows,
    })
  },
})
