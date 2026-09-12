import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { assess, readVitals } from '@/lib/api/vitals'

export const dynamic = 'force-dynamic'

/**
 * Is the memory still being written?
 *
 * Distinct from `/health`, which reports on the process and reported itself
 * healthy throughout two days of recording nothing.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const requested = Number(url.searchParams.get('hours'))
    const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 720) : 24

    const vitals = await readVitals(actor, hours)
    return ok({ ...vitals, findings: assess(vitals) })
  },
})
