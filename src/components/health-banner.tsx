import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { assess, cachedVitals } from '@/lib/api/vitals'

/**
 * The one place Cairn admits it has stopped working.
 *
 * `cairn vitals` can tell that sessions are no longer being recorded, and said
 * so into a task note — which only reaches somebody who already suspected
 * something and went looking. An alarm whose only reader is the person who
 * already knows is not an alarm.
 *
 * Alarms only. Warnings — work being abandoned, nothing closed — are habits
 * worth reading on the page but not worth a banner on every screen; a bar that
 * is always there is furniture within a day.
 */
export const HealthBanner = async ({ userId }: { userId: string }) => {
  let alarms: string[] = []
  try {
    const vitals = await cachedVitals(userId)
    alarms = assess(vitals)
      .filter((f) => f.severity === 'alarm')
      .map((f) => f.message)
  } catch {
    // The health check failing is not a reason to fail the page it sits on.
    return null
  }

  if (alarms.length === 0) return null

  return (
    <Link
      href="/vitals"
      className="border-danger/40 bg-danger-subtle hover:bg-danger-subtle/70 flex shrink-0 items-start gap-2 border-b px-3 py-2 transition-colors md:px-4"
    >
      <AlertTriangle size={13} className="text-danger mt-[2px] shrink-0" aria-hidden />
      <p className="text-fg min-w-0 text-[12.5px] leading-relaxed">
        {alarms[0]}
        {alarms.length > 1 ? (
          <span className="text-fg-muted"> · and {alarms.length - 1} more</span>
        ) : null}
      </p>
    </Link>
  )
}
