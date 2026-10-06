import type { Metadata } from 'next'
import { PendingLink } from '@/components/pending-link'
import { redirect } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react'
import { currentUser } from '@/lib/data'
import {
  assess,
  readMemoryUseFor,
  readVitalsFor,
  readWorkShapeFor,
  type Finding,
  type MemoryUse,
  type Vitals,
  type WorkShape,
} from '@/lib/api/vitals'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { localDay } from '@/lib/dates'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Vitals' }

const WINDOWS = [
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
  { hours: 720, label: '30d' },
]

/**
 * A number worth looking at, at a size that says so.
 *
 * The page used to render every figure at 12.5px in a column of hairlines, so
 * "28 sessions recorded" and "18 knowledge written" carried identical weight
 * and the eye had nowhere to land. Four numbers answer "is this thing well"
 * and they are the four that get scale.
 */
const Stat = ({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: 'good' | 'warn' | 'bad'
}) => (
  <div className="surface-card flex flex-col gap-0.5 px-3.5 py-3">
    <span className="text-fg-subtle text-label font-medium tracking-[0.06em] uppercase">
      {label}
    </span>
    <span
      className={cn(
        'font-display headline text-[1.625rem] leading-none tabular-nums',
        tone === 'bad' && 'text-danger',
        tone === 'warn' && 'text-status-doing',
        tone === 'good' && 'text-status-in-review',
        !tone && 'text-fg',
      )}
    >
      {value}
    </span>
    {hint ? <span className="text-fg-subtle text-meta">{hint}</span> : null}
  </div>
)

/** A section that reads as an object rather than a run of hairlines. */
const Panel = ({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) => (
  <section className="surface-card overflow-hidden">
    <header className="border-border flex items-baseline gap-2 border-b px-3.5 py-2">
      <h2 className="text-fg text-meta font-semibold">{title}</h2>
      {note ? <span className="text-fg-subtle text-meta">{note}</span> : null}
    </header>
    <div className="px-3.5 py-1">{children}</div>
  </section>
)

const Row = ({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: string
  hint?: string
  emphasis?: boolean
}) => (
  <div className="border-border flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
    <span className={cn('min-w-0 truncate text-ui', emphasis ? 'text-fg' : 'text-fg-muted')}>
      {label}
    </span>
    <span className="text-fg tabular shrink-0 text-ui">
      {value}
      {hint ? <span className="text-fg-subtle"> {hint}</span> : null}
    </span>
  </div>
)

type Tone = 'good' | 'warn' | 'bad'

const TONE: Record<Tone, string> = {
  good: 'var(--status-in-review)',
  warn: 'var(--status-doing)',
  bad: 'var(--danger)',
}

/** A finding: a flat tint of its tone, with a hairline of the same hue. */
const Banner = ({
  tone,
  icon: Icon,
  children,
}: {
  tone: Tone
  icon: LucideIcon
  children: React.ReactNode
}) => (
  <div
    className={cn(
      'flex items-start gap-2.5 rounded-lg border px-4 py-3',
      'border-[color:color-mix(in_oklab,var(--tone)_30%,transparent)]',
      'bg-[color-mix(in_oklab,var(--tone)_8%,transparent)]',
    )}
    style={{ '--tone': TONE[tone] } as React.CSSProperties}
  >
    <Icon
      size={15}
      className="mt-[2px] shrink-0 text-[color:var(--tone)]"
      aria-hidden
    />
    <div className="min-w-0">{children}</div>
  </div>
)

/**
 * The answer to the only question this page exists for, said once and loudly.
 *
 * Previously a grey sentence indistinguishable from the rows beneath it, which
 * is a strange way to report that everything is fine — and a worse one to
 * report that it is not.
 */
const Verdict = ({ findings }: { findings: Finding[] }) => {
  const alarms = findings.filter((f) => f.severity === 'alarm')
  const warnings = findings.filter((f) => f.severity === 'warning')

  if (findings.length === 0) {
    return (
      <Banner tone="good" icon={CheckCircle2}>
        <p className="text-fg text-ui font-medium">The memory is being written</p>
        <p className="text-fg-muted mt-0.5 text-ui leading-relaxed">
          Sessions are being recorded, work is being closed, and every agent that wrote last
          week has written today.
        </p>
      </Banner>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {[...alarms, ...warnings].map((f) => (
        <Banner
          key={f.code}
          tone={f.severity === 'alarm' ? 'bad' : 'warn'}
          icon={f.severity === 'alarm' ? AlertTriangle : Info}
        >
          <p className="text-fg text-ui leading-relaxed">{f.message}</p>
        </Banner>
      ))}
    </div>
  )
}

const VitalsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const requested = Number((await searchParams).hours)
  const hours = WINDOWS.some((w) => w.hours === requested) ? requested : 24
  const window = WINDOWS.find((w) => w.hours === hours)?.label ?? '24h'

  // Settled separately, not in one try. One aggregate failing used to blank
  // the whole page — the memory block's failure took the vital signs down
  // with it, which contradicts the API, where `memory: null` exists so that
  // one unanswerable question does not stop the others being answered.
  const [vitalsRead, workRead, memoryRead] = await Promise.allSettled([
    readVitalsFor(user.id, hours),
    readWorkShapeFor(user.id, hours),
    readMemoryUseFor(user.id, hours),
  ])
  const value = <T,>(r: PromiseSettledResult<T>): T | null =>
    r.status === 'fulfilled' ? r.value : null
  const reason = (r: PromiseSettledResult<unknown>, what: string) =>
    r.status === 'rejected'
      ? `${what}: ${r.reason instanceof Error ? r.reason.message : 'could not be read'}`
      : null
  const vitals: Vitals | null = value(vitalsRead)
  const work: WorkShape | null = value(workRead)
  const memory: MemoryUse | null = value(memoryRead)
  const failures = [
    reason(vitalsRead, 'Vital signs'),
    reason(workRead, 'Where work is stuck'),
    reason(memoryRead, 'Is the memory being read'),
  ].filter((f): f is string => f !== null)
  const signals = vitals?.signals ?? null

  const findings = vitals ? assess(vitals) : []
  const busiest = Math.max(1, ...(vitals?.agents ?? []).map((a) => a.recent))

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg text-ui font-medium">Vitals</span>
        <span className="border-border bg-surface-raised ml-auto flex items-center gap-0.5 rounded-md border p-0.5">
          {WINDOWS.map((w) => (
            <PendingLink
              key={w.hours}
              href={w.hours === 24 ? '/vitals' : `/vitals?hours=${w.hours}`}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-0.5 text-meta transition-[color,background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)]',
                w.hours === hours ? 'bg-surface text-fg ring-border ring-1' : 'text-fg-muted hover:text-fg',
              )}
            >
              {w.label}
            </PendingLink>
          ))}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Centred in the content column, like the task page and /projects.
            This was left-aligned on the reasoning that centring inside a shell
            which already has a sidebar leaves a dead column — true when every
            page did it, and no longer true the moment /projects shipped
            centred. A rule half the app follows is not a rule, it just reads
            as two pages somebody forgot. */}
          <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-5 md:px-6">
          {failures.map((f) => (
            <Banner key={f} tone="bad" icon={AlertTriangle}>
              <p className="text-danger text-ui">
                {f}
                {vitals ? ' — the rest of this page is still current.' : ''}
              </p>
            </Banner>
          ))}

          {vitals ? (
            <>
              <Verdict findings={findings} />

              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <Stat
                  label="Sessions"
                  value={vitals.sessions.recent}
                  hint={`${vitals.sessions.recentWithFiles} named a file`}
                  tone={vitals.sessions.recent === 0 ? 'bad' : undefined}
                />
                <Stat
                  label="Closed"
                  value={vitals.tasks.closed}
                  hint={`of ${vitals.tasks.opened} opened`}
                />
                <Stat
                  label="Stuck"
                  value={work?.stalledTotal ?? vitals.tasks.stalled}
                  hint={`of ${work?.openTotal ?? '—'} open`}
                  tone={(work?.stalledTotal ?? vitals.tasks.stalled) > 5 ? 'warn' : undefined}
                />
                <Stat label="Held" value={vitals.tasks.held} hint="right now" />
              </div>

              <Panel title="Who wrote" note={`last ${window}, against the week before`}>
                {vitals.agents.length === 0 ? (
                  <EmptyState compact title="Nobody, either window." />
                ) : (
                  vitals.agents.map((a, i) => (
                    <div key={a.agent} className="border-border border-b py-2 last:border-0">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="text-fg text-ui">{a.agent}</span>
                        <span className="text-fg tabular shrink-0 text-ui">
                          {a.recent}
                          <span className="text-fg-subtle"> ({a.baseline})</span>
                        </span>
                      </div>
                      {/* Relative volume, which a column of numbers does not
                          show: one agent writing ten times another is the
                          shape of the week, not a detail. */}
                      <div className="bg-surface-raised mt-1.5 h-[0.1875rem] rounded-full">
                        {/* Fills from the left as the page arrives: a CSS
                            transition from @starting-style, so it costs no
                            script and stands still under reduced motion. */}
                        <div
                          className={cn(
                            'bg-accent h-full origin-left scale-x-100 rounded-full starting:scale-x-0',
                            'transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)]',
                            'motion-safe:[transition-delay:calc(var(--i)*18ms+80ms)]',
                          )}
                          style={
                            {
                              width: `${Math.max(2, (a.recent / busiest) * 100)}%`,
                              '--i': Math.min(i, 14),
                            } as React.CSSProperties
                          }
                        />
                      </div>
                    </div>
                  ))
                )}
              </Panel>

              {work ? (
                <Panel
                  title="Where work is stuck"
                  note="Stalled: in progress with nobody on it. Never touched: filed, not edited since."
                >
                  {work.projects.length === 0 ? (
                    <EmptyState compact title="Nothing open." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-ui">
                        <thead>
                          <tr className="text-fg-subtle border-border border-b text-left text-meta">
                            <th className="py-1.5 font-medium whitespace-nowrap">Project</th>
                            <th className="py-1.5 pl-3 text-right font-medium whitespace-nowrap">Open</th>
                            <th className="py-1.5 pl-3 text-right font-medium whitespace-nowrap">Stalled</th>
                            <th className="py-1.5 pl-3 text-right font-medium whitespace-nowrap">Never touched</th>
                            <th className="py-1.5 pl-3 text-right font-medium whitespace-nowrap">Oldest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {work.projects.map((p) => (
                            <tr key={p.key} className="border-border border-b last:border-0">
                              <td className="text-fg py-1.5 font-medium">{p.key}</td>
                              <td className="text-fg tabular py-1.5 text-right">{p.open}</td>
                              <td
                                className={cn(
                                  'tabular py-1.5 text-right',
                                  p.stalled > 0 ? 'text-danger' : 'text-fg-subtle',
                                )}
                              >
                                {p.stalled}
                              </td>
                              <td
                                className={cn(
                                  'tabular py-1.5 text-right',
                                  p.neverTouched > 0 ? 'text-status-doing' : 'text-fg-subtle',
                                )}
                              >
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
                </Panel>
              ) : null}

              {work && work.holding.length > 0 ? (
                <Panel title="Held right now" note={`${work.holding.length} claimed`}>
                  {work.holding.map((h) => (
                    <Row
                      key={h.ref}
                      emphasis
                      label={`${h.ref} · ${h.title}`}
                      value={
                        h.heldMinutes >= 120
                          ? `${Math.round(h.heldMinutes / 60)}h`
                          : `${h.heldMinutes}m`
                      }
                      hint={h.agent}
                    />
                  ))}
                </Panel>
              ) : null}

              {signals ? (
                <Panel
                  title="Claims nobody is on"
                  note="Held, but no note, checkpoint or edit for a while."
                >
                  <Row
                    label="held, quiet for more than 2h"
                    value={`${signals.claims.quiet2h} of ${signals.claims.held}`}
                  />
                  <Row label="quiet for more than a day" value={String(signals.claims.quiet24h)} />
                  <Row
                    label="released automatically in 7 days"
                    value={String(signals.reaper.released7d)}
                    hint={
                      signals.reaper.lastReleaseAt
                        ? `(last ${localDay(signals.reaper.lastReleaseAt)})`
                        : '(never)'
                    }
                  />
                  {signals.claims.quietest.map((c) => (
                    <Row
                      key={c.ref}
                      label={`${c.ref} · ${c.title}`}
                      value={
                        c.quietMinutes === null
                          ? 'never active'
                          : c.quietMinutes >= 120
                            ? `${Math.round(c.quietMinutes / 60)}h`
                            : `${c.quietMinutes}m`
                      }
                      hint={c.claimedBy}
                    />
                  ))}
                </Panel>
              ) : null}

              {signals && signals.runtimes.length > 0 ? (
                <Panel
                  title="Sessions by runtime"
                  note={`last ${window} against the week before; summarised is the prose half`}
                >
                  <div className="overflow-x-auto">
                    <table className="w-full text-ui">
                      <thead>
                        <tr className="text-fg-subtle border-border border-b text-left text-meta">
                          <th className="py-1.5 font-medium">runtime</th>
                          <th className="py-1.5 font-medium">host</th>
                          <th className="py-1.5 pl-3 text-right font-medium">sessions</th>
                          <th className="py-1.5 pl-3 text-right font-medium">summarised</th>
                          <th className="py-1.5 pl-3 text-right font-medium">last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {signals.runtimes.map((r) => (
                          <tr key={`${r.runtime}@${r.host}`} className="border-border border-b last:border-0">
                            <td className="text-fg py-1.5 font-medium">{r.runtime}</td>
                            <td className="text-fg-muted py-1.5">{r.host}</td>
                            <td className="text-fg tabular py-1.5 text-right">
                              {r.recent}
                              <span className="text-fg-subtle"> ({r.baseline})</span>
                            </td>
                            <td className="text-fg tabular py-1.5 text-right">
                              {r.recent > 0 ? `${Math.round((r.recentSummarised / r.recent) * 100)}%` : '—'}
                              <span className="text-fg-subtle">
                                {` (${
                                  r.baseline > 0
                                    ? `${Math.round((r.baselineSummarised / r.baseline) * 100)}%`
                                    : '—'
                                })`}
                              </span>
                            </td>
                            <td className="text-fg-muted tabular py-1.5 text-right">
                              {localDay(r.lastSeenAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              ) : null}

              {memory ? (
                <Panel
                  title="Is the memory being read"
                  note="a search that widened is one the precise question could not answer"
                >
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
                  {memory.recentMisses.length > 0 ? (
                    <div className="py-2">
                      <p className="text-fg-subtle mb-1 text-meta">Asked for and not held</p>
                      <ul className="flex flex-col gap-0.5">
                        {memory.recentMisses.map((q) => (
                          <li key={q} className="text-fg-muted truncate text-meta">
                            {q}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/*
                    Looking a fact up by name, which migration 053 is the first
                    release to record. Conditional on there having been one:
                    the keys are absent on a server older than 053, and a row
                    reading `0` for a server that cannot count is a wrong
                    answer rather than a missing one. Zero-on-053 stays quiet
                    too — this panel is four rows and every permanently-zero
                    row spent here is one the eye learns to skip.
                  */}
                  {(memory.directReads ?? 0) > 0 || (memory.directReadMisses ?? 0) > 0 ? (
                    <>
                      <Row label="looked up by name" value={String(memory.directReads ?? 0)} />
                      <Row
                        label="naming a fact we do not hold"
                        value={String(memory.directReadMisses ?? 0)}
                        hint={
                          (memory.directReads ?? 0) > 0
                            ? `(${Math.round(((memory.directReadMisses ?? 0) / (memory.directReads as number)) * 100)}%)`
                            : undefined
                        }
                      />
                    </>
                  ) : null}

                  {(memory.recentSlugMisses ?? []).length > 0 ? (
                    <div className="py-2">
                      <p className="text-fg-subtle mb-1 text-meta">
                        Looked up by name, no such entry
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {(memory.recentSlugMisses ?? []).map((slug) => (
                          <li key={slug} className="text-fg-muted truncate font-mono text-meta">
                            {slug}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </Panel>
              ) : null}

              <div className="grid gap-5 md:grid-cols-2">
                <Panel title="Sessions" note={`last ${window}`}>
                  <Row
                    label="recorded"
                    value={String(vitals.sessions.recent)}
                    hint={`(${vitals.sessions.baseline} the week before)`}
                  />
                  <Row
                    label="naming at least one file"
                    value={String(vitals.sessions.recentWithFiles)}
                    hint={`(${vitals.sessions.baselineWithFiles})`}
                  />
                  <Row
                    label="summarised"
                    value={String(vitals.sessions.recentSummarised)}
                    hint={signals ? `(${signals.sessions.baselineSummarised})` : undefined}
                  />
                  {signals && signals.sessions.summariserRecent > 0 ? (
                    <Row
                      label="summariser runs, not counted"
                      value={String(signals.sessions.summariserRecent)}
                    />
                  ) : null}
                  <Row label="knowledge written" value={String(vitals.knowledgeWritten)} />
                  {/* Informational: nothing yet says how often a fact should
                      be re-checked, so this is a number to read, not an alarm. */}
                  {signals ? (
                    <Row
                      label="knowledge never verified"
                      value={`${signals.knowledge.neverVerified} of ${signals.knowledge.current}`}
                      hint={`(${signals.knowledge.unverified30d} not in 30 days)`}
                    />
                  ) : null}
                  <Row
                    label="claims released automatically"
                    value={String(vitals.autoReleased)}
                  />
                </Panel>

                {work ? (
                  <Panel title="Work that came back" note="hard to game: moving it means not making a mess">
                    <Row label="reopened after closing" value={String(work.rework.reopened)} />
                    <Row label="resolutions revised" value={String(work.rework.resolutionsRevised)} />
                    <Row label="filed as a duplicate" value={String(work.rework.duplicatesFiled)} />
                    {work.dropped.length > 0 ? (
                      work.dropped.map((d) => (
                        <Row
                          key={d.agent}
                          label={`${d.agent} started and walked away from`}
                          value={String(d.count)}
                        />
                      ))
                    ) : null}
                  </Panel>
                ) : null}
              </div>

              <p className="text-fg-subtle text-meta leading-relaxed">
                Counts cover the last {window}, against the week before it, scaled to the same
                length — a count alone says nothing. There is deliberately no ranking of agents:
                Cairn is their working memory, and a visible score would be something to optimise.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default VitalsPage
