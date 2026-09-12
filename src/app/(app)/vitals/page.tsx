import { redirect } from 'next/navigation'
import { AlertTriangle, Info } from 'lucide-react'
import { currentUser } from '@/lib/data'
import { assess, readVitalsFor, type Vitals } from '@/lib/api/vitals'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

/**
 * Whether the memory is still being written.
 *
 * Deliberately uncached, unlike the banner: someone who has opened this page is
 * asking the question now, and a five-minute-old answer is the wrong one to
 * give them.
 */
const Row = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="border-border flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
    <span className="text-fg-muted text-[12.5px]">{label}</span>
    <span className="text-fg tabular shrink-0 text-[12.5px]">
      {value}
      {hint ? <span className="text-fg-subtle"> {hint}</span> : null}
    </span>
  </div>
)

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-6">
    <h2 className="text-fg-subtle mb-1.5 text-[11px] font-medium tracking-[0.04em] uppercase">
      {title}
    </h2>
    {children}
  </section>
)

const VitalsPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  let vitals: Vitals | null = null
  let failure: string | null = null
  try {
    vitals = await readVitalsFor(user.id)
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Could not read the vital signs.'
  }

  const findings = vitals ? assess(vitals) : []
  const window = vitals ? `${vitals.windowHours}h` : '24h'

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-2 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <span className="text-fg text-[13px] font-medium">Vitals</span>
        <span className="text-fg-subtle text-[13px]">· last {window}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-5">
          {failure ? <p className="text-danger text-[13px]">{failure}</p> : null}

          {vitals ? (
            <>
              <Section title="What looks wrong">
                {findings.length === 0 ? (
                  <p className="text-fg-muted text-[13px]">
                    Nothing. Sessions are being recorded, work is being closed, and every agent
                    that wrote last week has written today.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {findings.map((f) => (
                      <li
                        key={f.code}
                        className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
                          f.severity === 'alarm'
                            ? 'border-danger/40 bg-danger-subtle'
                            : 'border-border bg-surface'
                        }`}
                      >
                        {f.severity === 'alarm' ? (
                          <AlertTriangle size={13} className="text-danger mt-[3px] shrink-0" aria-hidden />
                        ) : (
                          <Info size={13} className="text-fg-subtle mt-[3px] shrink-0" aria-hidden />
                        )}
                        <span className="text-fg text-[12.5px] leading-relaxed">{f.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Sessions">
                <Row
                  label="recorded"
                  value={String(vitals.sessions.recent)}
                  hint={`(${vitals.sessions.baseline} the week before)`}
                />
                {/* The count alone stayed healthy through a two-day outage in
                    which every session that touched a file was rejected. */}
                <Row
                  label="naming at least one file"
                  value={String(vitals.sessions.recentWithFiles)}
                  hint={`(${vitals.sessions.baselineWithFiles})`}
                />
              </Section>

              <Section title="Work">
                <Row label="tasks opened" value={String(vitals.tasks.opened)} />
                <Row label="tasks closed" value={String(vitals.tasks.closed)} />
                <Row label="in progress, nobody holding" value={String(vitals.tasks.stalled)} />
                <Row label="held right now" value={String(vitals.tasks.held)} />
                <Row label="claims released automatically" value={String(vitals.autoReleased)} />
                <Row label="knowledge written" value={String(vitals.knowledgeWritten)} />
              </Section>

              <Section title="Who wrote">
                {vitals.agents.length === 0 ? (
                  <p className="text-fg-muted text-[13px]">Nobody, in the window or the week before.</p>
                ) : (
                  vitals.agents.map((a) => (
                    <Row
                      key={a.agent}
                      label={a.agent}
                      value={String(a.recent)}
                      hint={`(${a.baseline} the week before)`}
                    />
                  ))
                )}
              </Section>

              <p className="text-fg-subtle text-[11px] leading-relaxed">
                Counts cover the last {window}, against the week before it. A count on its own
                says little — every check here compares the two, scaled to the same length.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default VitalsPage
