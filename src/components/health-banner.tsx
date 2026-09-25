import Link from 'next/link'
import { AlertTriangle, HelpCircle } from 'lucide-react'
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
  } catch (error) {
    // The health check failing is not a reason to fail the page it sits on,
    // and not a reason to say nothing either. This used to return null, so a
    // broken vitals read rendered exactly like a healthy one — the one state
    // a health banner must never be able to confuse. See CAIRN-288.
    console.error('[health-banner] could not read vitals', error instanceof Error ? error.message : error)
    return (
      <Link
        href="/vitals"
        className="border-border bg-surface-raised hover:bg-surface flex shrink-0 items-center gap-2 border-b px-3 py-1 transition-colors md:px-4"
      >
        <HelpCircle size={12} className="text-fg-subtle shrink-0" aria-hidden />
        <p className="text-fg-muted min-w-0 text-[0.71875rem]">
          Vitals unavailable — Cairn cannot currently tell whether it is working.
        </p>
      </Link>
    )
  }

  if (alarms.length === 0) return null

  return (
    <Link
      href="/vitals"
      className="border-danger/40 bg-danger-subtle hover:bg-danger-subtle/70 flex shrink-0 items-start gap-2 border-b px-3 py-2 transition-colors md:px-4"
    >
      <AlertTriangle size={13} className="text-danger mt-[2px] shrink-0" aria-hidden />
      <p className="text-fg min-w-0 text-[0.78125rem] leading-relaxed">
        {alarms[0]}
        {alarms.length > 1 ? (
          <span className="text-fg-muted"> · and {alarms.length - 1} more</span>
        ) : null}
      </p>
    </Link>
  )
}
