import { redirect } from 'next/navigation'
import { AlertTriangle, Info } from 'lucide-react'
import { currentUser } from '@/lib/data'
import {
  assess,
  readMemoryUseFor,
  readVitalsFor,
  readWorkShapeFor,
  type MemoryUse,
  type Vitals,
  type WorkShape,
} from '@/lib/api/vitals'
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
  let work: WorkShape | null = null
  let memory: MemoryUse | null = null
  let failure: string | null = null
  try {
    ;[vitals, work, memory] = await Promise.all([
      readVitalsFor(user.id),
      readWorkShapeFor(user.id),
      readMemoryUseFor(user.id),
    ])
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
        <div className="max-w-3xl px-4 py-5 md:px-6">
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

              {work ? (
                <>
                  <Section title={`Where work is stuck · ${work.openTotal} open`}>
                    {work.projects.length === 0 ? (
                      <p className="text-fg-muted text-[13px]">Nothing open.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12.5px]">
                          <thead>
                            <tr className="text-fg-subtle border-border border-b text-left text-[11px]">
                              <th className="py-1.5 font-medium">project</th>
                              <th className="py-1.5 text-right font-medium">open</th>
                              <th className="py-1.5 text-right font-medium">stalled</th>
                              <th className="py-1.5 text-right font-medium">never touched</th>
                              <th className="py-1.5 text-right font-medium">oldest</th>
                            </tr>
                          </thead>
                          <tbody>
                            {work.projects.map((p) => (
                              <tr key={p.key} className="border-border border-b last:border-0">
                                <td className="text-fg py-1.5">{p.key}</td>
                                <td className="text-fg tabular py-1.5 text-right">{p.open}</td>
                                <td
                                  className={`tabular py-1.5 text-right ${p.stalled > 0 ? 'text-danger' : 'text-fg-subtle'}`}
                                >
                                  {p.stalled}
                                </td>
                                <td className="text-fg-muted tabular py-1.5 text-right">
                                  {p.neverTouched}
                                </td>
                                <td className="text-fg-muted tabular py-1.5 text-right">
                                  {p.oldestDays}d
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="text-fg-subtle mt-2 text-[11px] leading-relaxed">
                      <strong className="font-medium">Never touched</strong> is filed and not
                      edited since — nobody has picked it up at all.{' '}
                      <strong className="font-medium">Stalled</strong> is in progress with nobody
                      holding it.
                    </p>
                  </Section>

                  <Section title="Held right now">
                    {work.holding.length === 0 ? (
                      <p className="text-fg-muted text-[13px]">Nothing is claimed.</p>
                    ) : (
                      work.holding.map((h) => (
                        <Row
                          key={h.ref}
                          label={`${h.ref} · ${h.title}`}
                          value={
                            h.heldMinutes >= 120
                              ? `${Math.round(h.heldMinutes / 60)}h`
                              : `${h.heldMinutes}m`
                          }
                          hint={h.agent}
                        />
                      ))
                    )}
                  </Section>

                  {work.dropped.length > 0 ? (
                    <Section title="Started and walked away from">
                      {work.dropped.map((d) => (
                        <Row key={d.agent} label={d.agent} value={String(d.count)} hint="tasks" />
                      ))}
                    </Section>
                  ) : null}

                  <Section title="Work that came back">
                    <Row label="reopened after being closed" value={String(work.rework.reopened)} />
                    <Row
                      label="resolutions revised"
                      value={String(work.rework.resolutionsRevised)}
                    />
                    <Row label="filed as a duplicate" value={String(work.rework.duplicatesFiled)} />
                    <p className="text-fg-subtle mt-2 text-[11px] leading-relaxed">
                      The one quality signal here that is hard to game: moving it means not
                      making a mess in the first place.
                    </p>
                  </Section>
                </>
              ) : null}

              {memory ? (
                <Section title="Is the memory being read">
                  <Row label="searches" value={String(memory.searches)} />
                  <Row
                    label="that had to guess"
                    value={String(memory.widened)}
                    hint={
                      memory.searches > 0
                        ? `(${Math.round((memory.widened / memory.searches) * 100)}%)`
                        : undefined
                    }
                  />
                  <Row
                    label="tasks filed without checking first"
                    value={`${memory.tasksFiledWithoutChecking} of ${memory.tasksFiled}`}
                  />
                  {memory.byAgent.map((a) => (
                    <Row key={a.agent} label={a.agent} value={String(a.searches)} hint="searches" />
                  ))}

                  {memory.recentMisses.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-fg-subtle mb-1 text-[11px] font-medium">
                        Asked for and not found
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {memory.recentMisses.map((q) => (
                          <li key={q} className="text-fg-muted truncate text-[12px]">
                            {q}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <p className="text-fg-subtle mt-2 text-[11px] leading-relaxed">
                    The premise of Cairn is that an agent checks before starting, and until
                    now nothing recorded whether that happened. The searches that had to guess
                    are the informative ones: search runs precise first and widens to an OR of
                    the terms when that matches nothing, so it almost never comes back empty —
                    a query about something Cairn had never heard of returned twenty loose
                    matches. Widening, not emptiness, is what &ldquo;we do not have this&rdquo;
                    looks like. Counting starts from when this shipped, so the first day is
                    short by construction.
                  </p>
                </Section>
              ) : null}

              <p className="text-fg-subtle text-[11px] leading-relaxed">
                Counts cover the last {window}, against the week before it. A count on its own
                says little — every check here compares the two, scaled to the same length.
                There is deliberately no ranking of agents: Cairn is their working memory, and a
                visible score would be something to optimise.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default VitalsPage
