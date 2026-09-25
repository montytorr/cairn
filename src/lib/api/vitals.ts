import { unstable_cache } from 'next/cache'
import { admin } from '@/lib/db/client'
import type { Actor } from './auth'

/**
 * Whether Cairn is still working.
 *
 * Everything that broke this week broke quietly. Sessions recorded nothing for
 * two days; ten tasks sat in In Progress with nobody on them; every automatic
 * release was filed under the wrong agent. Nothing threw. Each was a number
 * that should not have been what it was, and each was found by a person
 * looking rather than by the system saying so.
 *
 * So the check is deliberately not "is the service up" — the liveness probe
 * already answers that, and answered it happily throughout. It is "is the
 * memory still being written", which is a different question and the one that
 * actually matters.
 */

export type Vitals = {
  windowHours: number
  sessions: {
    recent: number
    recentWithFiles: number
    /** Sessions whose prose half was actually written by the summariser. */
    recentSummarised: number
    baseline: number
    baselineWithFiles: number
  }
  tasks: {
    opened: number
    closed: number
    stalled: number
    held: number
    /**
     * Closed in the window by a runtime, with nothing recorded between filing
     * and close that anyone was on it: no claim, no checkpoint, no status move
     * off the status it was filed in, no commit, no push, no test run.
     *
     * Not "never claimed", which is what this counted until migration 054 and
     * what made it wrong — nine of ten it flagged had moved to in-review hours
     * earlier, several with commits against them. A claim is one way of being
     * visible, not the only one. See CAIRN-251.
     *
     * Optional because a server older than migration 054 does not send it —
     * one on 051 sends the old key under the old meaning — and a check that
     * cannot see the number must not invent one.
     */
    closedWithoutTrace?: number
  }
  autoReleased: number
  knowledgeWritten: number
  // actorType is optional because a server that predates migration 050 does
  // not send it. Absent means "assume runtime" — see the check below.
  agents: { agent: string; actorType?: string; recent: number; baseline: number }[]
  /**
   * What cairn_vitals cannot see: claim liveness, the reaper, the summariser
   * and session volume per runtime and host, knowledge verification. From
   * migration 065, in a function of its own.
   *
   * Optional and nullable for the reason `closedWithoutTrace` is: a database
   * without 065 cannot answer, and a check that cannot see a number must not
   * invent one. `signalsError` says why it is missing, so the absence is
   * itself reported rather than read as health.
   */
  signals?: VitalsSignals | null
  signalsError?: string
}

export type RuntimeHost = {
  runtime: string
  host: string
  recent: number
  recentSummarised: number
  baseline: number
  baselineSummarised: number
  lastSeenAt: string
}

export type QuietClaim = {
  ref: string
  title: string
  claimedBy: string
  lastActivityAt: string | null
  /** null when nothing at all was ever recorded against the claim. */
  quietMinutes: number | null
}

export type VitalsSignals = {
  windowHours: number
  /** Session totals with the summariser's own runs taken out. */
  sessions: {
    recent: number
    recentSummarised: number
    baseline: number
    baselineSummarised: number
    summariserRecent: number
    summariserBaseline: number
  }
  runtimes: RuntimeHost[]
  claims: { held: number; quiet2h: number; quiet24h: number; quietest: QuietClaim[] }
  reaper: {
    releasedInWindow: number
    released7d: number
    lastReleaseAt: string | null
    maintenanceLastWriteAt: string | null
  }
  absentAgents: { agent: string; lastSeenAt: string }[]
  knowledge: {
    current: number
    neverVerified: number
    unverified30d: number
    verifiedInWindow: number
    lastVerifiedAt: string | null
  }
}

export type Finding = {
  code: string
  severity: 'alarm' | 'warning'
  message: string
}

/** The baseline the function returns covers a week. */
const BASELINE_HOURS = 168

/**
 * What the numbers mean.
 *
 * Pure, because this is the part worth testing and the part that will be
 * argued with. A count on its own says nothing: "no sessions today" is alarming
 * on a working week and meaningless over Christmas, so every check compares
 * against the week before, scaled to the same window length.
 */
export const assess = (v: Vitals): Finding[] => {
  const findings: Finding[] = []
  const scale = v.windowHours / BASELINE_HOURS
  const expected = (baseline: number) => baseline * scale
  const hours = `${v.windowHours}h`

  // The two-day outage, in one check. Hooks that stop firing produce silence,
  // and silence is indistinguishable from a quiet day unless you look back.
  //
  // It used to end "The session hooks are not running, or cannot write," and
  // that sentence was wrong both times it mattered. Once the runtimes were out
  // of tokens, so there was nothing to record and every hook was fine. Once the
  // hooks fired, the key authenticated and the parser worked — but the sessions
  // had been open for two days and the only trigger was SessionEnd, which had
  // not come. Both times the guess was read as the diagnosis and cost an hour.
  //
  // A count of zero cannot distinguish a runtime with nothing to say from one
  // that cannot speak. So say what was seen, and name the one command that
  // tells them apart.
  if (v.sessions.recent === 0 && expected(v.sessions.baseline) >= 1) {
    findings.push({
      code: 'no-sessions',
      severity: 'alarm',
      message:
        `No session recorded in ${hours}, against ${v.sessions.baseline} in the week before. ` +
        `That is the observation, not the cause: an idle runtime, a hook that never fired ` +
        `and a hook that could not write all produce it. ` +
        `cairn-session-end.mjs --dry-run <transcript> separates them.`,
    })
  }

  // The jsonb bug, in one check. Sessions kept being written; the ones that
  // touched a file — nearly all real work — were the ones being rejected, so
  // the total never went to zero and nothing looked wrong.
  if (
    v.sessions.recent >= 3 &&
    v.sessions.recentWithFiles === 0 &&
    v.sessions.baselineWithFiles > 0
  ) {
    findings.push({
      code: 'sessions-without-files',
      severity: 'alarm',
      message:
        `${v.sessions.recent} sessions recorded in ${hours} and not one names a file. ` +
        `Sessions that touch files are failing, or the file index is not being written.`,
    })
  }

  /**
   * Sessions recorded, none of them summarised.
   *
   * A session is two halves: the files and refs, taken from the transcript,
   * and the prose — what was asked, learned, completed, left — which costs a
   * model call. The hook deliberately swallows a failed summariser rather than
   * lose the row, which is right, and means the prose half can stop being
   * written without anything failing.
   *
   * It did. `claude -p` as root answered "Not logged in", the OpenClaw sweep
   * runs as root because the transcripts sit under a 0700 home, and 42 of 42
   * OpenClaw sessions were recorded with no prose at all for the life of the
   * feature. Nothing was broken enough to notice: the rows were there, the
   * counts were healthy, and every one of them was half a session.
   */
  if (v.sessions.recent >= 3 && v.sessions.recentSummarised === 0) {
    findings.push({
      code: 'sessions-without-summary',
      severity: 'alarm',
      message:
        `${v.sessions.recent} sessions recorded in ${hours} and not one was summarised. ` +
        `The summariser is failing silently — the hook keeps the row when it cannot ` +
        `reach one, so this is the only place it shows.`,
    })
  }

  // Historical activity does not mean a runtime is expected to be active in
  // every window. In particular, direct Codex may be idle while OpenClaw
  // (which can run Codex underneath it) and Claude Code continue writing.
  // Keep this as a qualified warning, not an alarm: silence is a prompt to
  // verify runtime usage, never proof that hooks or keys are broken.
  for (const agent of v.agents) {
    // A person is not a runtime that has gone quiet. The owner of an instance
    // appears in this list because he clicks things in the web UI, and telling
    // him his hooks may be broken is both wrong and the kind of wrong that
    // teaches people to skim the whole panel.
    //
    // Tested against 'human' rather than for 'agent': a payload from a server
    // older than migration 050 carries no actorType at all, and on such a
    // server everything in this list was a runtime as far as anyone knew.
    // Silently dropping the check there would be worse than the false
    // positive it removes.
    if (agent.actorType === 'human') continue
    // The reaper writes only when it releases something, so its silence is a
    // fact about the claims, not about its wiring. It is judged by the claim
    // checks below, against the claims it should have taken.
    if (isMaintenance(agent.agent)) continue
    if (agent.recent === 0 && expected(agent.baseline) >= 3) {
      findings.push({
        code: 'agent-silent',
        severity: 'warning',
        message:
          `${agent.agent} has written nothing in ${hours}, against ${agent.baseline} in the week ` +
          `before. This may simply be an idle runtime; verify it was expected to be active ` +
          `before investigating hooks or keys.`,
      })
    }
  }

  // Also a habit rather than a breakage, and the one CAIRN-135 measured at 36%
  // of closed tasks before shipping auto-claim on note and checkpoint. That
  // number had no reader afterwards: nothing recomputed it, so nobody would
  // have known if it went back up. This is the reader.
  //
  // It read the wrong thing until migration 054. CAIRN-251 classified all ten
  // tasks it flagged in a 24h window: none was the bare created->done shape it
  // was filed for, nine had moved to in-review hours earlier, several carried
  // commits and test runs. So it counted two things it should not have — a
  // person closing their own work, who is documented as never claiming and
  // whom claim.ts refuses to claim for, the same exclusion agent-silent makes
  // twenty lines above; and the backlog sweep the skill explicitly instructs,
  // one task filed and claimed for the sweep and the rest worked without
  // claiming them.
  //
  // So the question is no longer "was this claimed" but "could anyone see it
  // being worked": no claim, no checkpoint, no status move off the status it
  // was filed in, no commit, no push, no test run, between filing and close.
  // The message says that, because a corrected predicate under the old prose
  // is the same bug with better numbers.
  //
  // A ratio rather than a count, because what matters is the share of the work
  // nobody could see — and a floor under it, because one of two proves nothing
  // and crying about it teaches people to skip the line.
  //
  // Deliberately not an alarm, deliberately not auto-claim on close, and
  // deliberately not a hint on `cairn done`. CAIRN-146 rejected inferring
  // intent from an ambiguous signal, and closing is at least as ambiguous as
  // annotating: --kind verified exists precisely for closing somebody else's
  // fix. CAIRN-211 refused the per-call nag — it "is not actionable, and
  // trains people to ignore the line" — and CAIRN-135 called restating the
  // rule "the third version of the same non-fix".
  const untraced = v.tasks.closedWithoutTrace
  if (untraced !== undefined && v.tasks.closed >= 5 && untraced / v.tasks.closed >= 0.25) {
    findings.push({
      code: 'closed-without-trace',
      severity: 'warning',
      message:
        `${untraced} of ${v.tasks.closed} tasks closed in ${hours} went from filed to closed with ` +
        `nothing recorded in between — no claim, no status move, no commit, no test run. ` +
        `Nothing said the work was happening while it happened, so the board showed them free, ` +
        `and had one crashed halfway it would have looked untouched rather than abandoned. ` +
        `\`cairn add --start\`, or claim before you begin.`,
    })
  }

  // Not a breakage — a habit. Worth saying once it is a pattern rather than
  // an incident, which is why this is a count and not a ratio.
  if (v.tasks.stalled > 5) {
    findings.push({
      code: 'stalled-work',
      severity: 'warning',
      message:
        `${v.tasks.stalled} tasks are in progress with nobody holding them. ` +
        `Started and dropped is the easiest work in the tracker to lose.`,
    })
  }

  if (v.autoReleased >= 5) {
    findings.push({
      code: 'claims-abandoned',
      severity: 'warning',
      message:
        `${v.autoReleased} claims were released automatically in ${hours}. ` +
        `Work is being claimed and then left.`,
    })
  }

  // Opening without closing is how a tracker becomes a landfill. Only worth
  // saying when the sample is big enough to be a trend.
  if (v.tasks.opened >= 5 && v.tasks.closed === 0) {
    findings.push({
      code: 'nothing-closed',
      severity: 'warning',
      message: `${v.tasks.opened} tasks opened in ${hours} and none closed.`,
    })
  }

  findings.push(...assessSignals(v))

  return findings
}

export const isMaintenance = (actorId: string) =>
  actorId === 'maintenance' || actorId.startsWith('maintenance · ')

/**
 * How long a claim may be quiet before the reaper is expected to have taken
 * it: its 120-minute threshold (src/lib/api/reconcile.ts), plus the 30-minute
 * schedule it runs on, plus one missed run of slack.
 */
export const REAPER_REACH_MINUTES = 120 + 30 + 30

const formatQuiet = (minutes: number | null) =>
  minutes === null ? 'never active' : minutes >= 120 ? `${Math.round(minutes / 60)}h` : `${minutes}m`

const formatAgo = (iso: string | null, now: number) =>
  iso ? `${formatQuiet(Math.round((now - new Date(iso).getTime()) / 60_000))} ago` : 'never'

const label = (r: Pick<RuntimeHost, 'runtime' | 'host'>) => `${r.runtime}@${r.host}`

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`

/**
 * The checks migration 065 made possible, each one a blind spot CAIRN-282
 * found reading green while it failed.
 *
 * Grouped into one finding per check, listing every runtime or claim it
 * concerns, rather than one finding each. Six rows of "summariser degraded"
 * are read as noise; one row naming six runtimes is read as a pattern.
 */
export const assessSignals = (v: Vitals, now = Date.now()): Finding[] => {
  const findings: Finding[] = []
  const hours = `${v.windowHours}h`
  const scale = v.windowHours / BASELINE_HOURS

  if (v.signals === undefined) return findings
  if (v.signals === null) {
    findings.push({
      code: 'signals-unavailable',
      severity: 'warning',
      message:
        `Claim liveness, the reaper, and summariser and session volume per runtime could not be read` +
        (v.signalsError ? ` (${v.signalsError})` : '') +
        `. Those checks are not running, which is not the same as passing.`,
    })
    return findings
  }

  const s = v.signals

  // --- claims nobody is on ------------------------------------------------
  //
  // `held` was a bare count and `stalled` only counts UNclaimed work, so a
  // claim abandoned for a week was invisible unless the reaper released it —
  // and the reaper had released nothing for thirteen days. Liveness is
  // task_genuine_activity_at (065), which is the reaper's own lastSignOfLife
  // in SQL: if the two disagreed, `reaper-idle` would alarm about claims the
  // reaper rightly keeps. src/lib/liveness-fixtures.ts pins them together.
  const worst = s.claims.quietest
  const oldestQuiet = worst.length
    ? Math.max(...worst.map((c) => c.quietMinutes ?? Number.POSITIVE_INFINITY))
    : 0
  const beyondReaper = oldestQuiet >= REAPER_REACH_MINUTES

  if (s.claims.quiet24h > 0 || s.claims.quiet2h >= 3) {
    const named = worst
      .slice(0, 3)
      .map((c) => `${c.ref} (${formatQuiet(c.quietMinutes)}, ${c.claimedBy})`)
      .join(', ')
    findings.push({
      code: 'claims-quiet',
      severity: 'warning',
      message:
        `${s.claims.quiet2h} of ${s.claims.held} claims have had no note, checkpoint, status move or ` +
        `heartbeat for more than 2h, ${s.claims.quiet24h} of them for more than a day: ${named}. ` +
        `The board shows them taken while nobody is on them.`,
    })
  }

  // The reaper, judged by the only trace it leaves: a release. With nothing
  // to take, it rightly releases nothing, so its silence only means something
  // when a claim has been quiet for longer than it takes to reach one.
  const reaperNote =
    `Last automatic release ${formatAgo(s.reaper.lastReleaseAt, now)}; ` +
    `the maintenance identity last wrote ${formatAgo(s.reaper.maintenanceLastWriteAt, now)}. ` +
    `\`CAIRN_AGENT=maintenance cairn reconcile --dry-run\` shows what it would take.`
  if (beyondReaper && s.reaper.released7d === 0) {
    findings.push({
      code: 'reaper-idle',
      severity: 'alarm',
      message:
        `Claims have been quiet for up to ${formatQuiet(Number.isFinite(oldestQuiet) ? oldestQuiet : null)} ` +
        `and nothing has been released automatically in 7 days. The reaper runs every 30 minutes ` +
        `and should have taken them. ${reaperNote}`,
    })
  } else if (beyondReaper && s.reaper.releasedInWindow === 0) {
    findings.push({
      code: 'maintenance-silent',
      severity: 'warning',
      message:
        `Claims have been quiet past the reaper's reach and it released nothing in ${hours}. ` +
        reaperNote,
    })
  }

  // --- the summariser, per runtime and host --------------------------------
  //
  // The alarm above fires only when not one session was summarised. On 09-24
  // one of sixteen was — openclaw 0/8, codex 0/2 — against about 75% the week
  // before, and one success was enough to stay green. The ratio is compared
  // with the same runtime's own baseline because runtimes summarise at
  // different rates for good reasons; the 50% floor catches one with no
  // baseline to compare with.
  const degraded = s.runtimes.filter((r) => {
    if (r.recent === 0) return false
    const ratio = r.recentSummarised / r.recent
    const baselineRatio = r.baseline >= 3 ? r.baselineSummarised / r.baseline : null
    const belowBaseline = baselineRatio !== null && r.recent >= 2 && ratio < baselineRatio / 2
    const belowFloor = r.recent >= 3 && ratio < 0.5
    return belowBaseline || belowFloor
  })
  if (degraded.length > 0) {
    findings.push({
      code: 'summariser-degraded',
      severity: 'warning',
      message:
        `The summariser is writing less than it did: ` +
        degraded
          .map(
            (r) =>
              `${label(r)} ${r.recentSummarised}/${r.recent} in ${hours}` +
              (r.baseline > 0 ? ` against ${pct(r.baselineSummarised, r.baseline)} the week before` : ''),
          )
          .join('; ') +
        `. The hook keeps the row when the summariser fails, so this is the only place it shows.`,
    })
  }

  // --- session volume, per runtime and host --------------------------------
  //
  // The total only alarmed at exactly zero, and a total cannot say which
  // runtime went quiet: codex at zero for a day and openclaw's scheduled runs
  // stopping were both inside a healthy-looking eight.
  const volume = s.runtimes
    .map((r) => ({ ...r, expected: r.baseline * scale }))
    .filter((r) => r.expected >= 1 && (r.recent === 0 || (r.expected >= 3 && r.recent < r.expected * 0.3)))
  if (volume.length > 0) {
    findings.push({
      code: 'runtime-quiet',
      severity: 'warning',
      message:
        `Fewer sessions than the week before: ` +
        volume
          .map((r) => `${label(r)} ${r.recent} in ${hours}, about ${Math.round(r.expected)} expected`)
          .join('; ') +
        `. An idle runtime and a hook that stopped firing look the same here; ` +
        `check it was meant to be running.`,
    })
  }

  // Seen in the month before and not since, so cairn_vitals' lists — which
  // only reach back a week — no longer contain them at all.
  const gone = s.runtimes.filter((r) => r.recent === 0 && r.baseline === 0)
  const goneAgents = s.absentAgents
  if (gone.length > 0 || goneAgents.length > 0) {
    findings.push({
      code: 'runtime-absent',
      severity: 'warning',
      message:
        `Not heard from in ${hours} or the week before: ` +
        [
          ...gone.map((r) => `${label(r)} sessions (last ${formatAgo(r.lastSeenAt, now)})`),
          ...goneAgents.map((a) => `${a.agent} writes (last ${formatAgo(a.lastSeenAt, now)})`),
        ].join('; ') +
        `. Retired on purpose, or stopped without anyone noticing.`,
    })
  }

  return findings
}

/**
 * The shape of the work, as opposed to the health of the system.
 *
 * Deliberately not a leaderboard. The agents read Cairn -- it is their working
 * memory -- so a visible closure score creates an incentive to close things,
 * which is the one behaviour least worth optimising. Per agent there is only
 * what is actionable: what it holds now, and what it walked away from.
 */
export type WorkShape = {
  windowHours: number
  openTotal: number
  stalledTotal: number
  projects: { key: string; open: number; stalled: number; oldestDays: number; neverTouched: number }[]
  holding: { agent: string; ref: string; title: string; heldMinutes: number }[]
  dropped: { agent: string; count: number }[]
  rework: { reopened: number; resolutionsRevised: number; duplicatesFiled: number }
}

export const readWorkShapeFor = async (userId: string, hours = 24): Promise<WorkShape> => {
  const { data, error } = await admin().rpc('cairn_work_shape', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as WorkShape
}

/**
 * Whether anybody consults what is already known.
 *
 * Every other number in here describes what was written; none described
 * whether any of it was read. A store nobody queries is an expensive way to
 * write into a drawer.
 */
export type MemoryUse = {
  windowHours: number
  searches: number
  widened: number
  zeroResults: number
  byAgent: { agent: string; searches: number }[]
  tasksFiled: number
  tasksFiledWithoutChecking: number
  recentMisses: string[]
  /**
   * Facts fetched by name rather than searched for -- `cairn know <slug>` and
   * every browser read of an entry. It is the path that best answers "do we
   * call knowledge when we need it", and until migration 053 it was the one
   * path with no instrumentation on it at all.
   *
   * Optional, like `tasks.closedWithoutTrace` above, because a server older
   * than 053 does not send it, and a display that cannot see the number must
   * not print a zero in its place: "nobody looked anything up" and "this
   * server cannot tell you" are opposite answers.
   */
  directReads?: number
  /**
   * Of those, how many named a slug nothing holds. A dangling knowledge
   * reference caught as it is being followed, which is why this is the number
   * worth reading rather than the total.
   */
  directReadMisses?: number
  /** The most recent of those slugs, newest first. */
  recentSlugMisses?: string[]
}

export const readMemoryUseFor = async (userId: string, hours = 24): Promise<MemoryUse> => {
  const { data, error } = await admin().rpc('cairn_memory_use', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as MemoryUse
}

export const readSignalsFor = async (userId: string, hours = 24): Promise<VitalsSignals> => {
  const { data, error } = await admin().rpc('cairn_vitals_signals', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as VitalsSignals
}

/**
 * The vital signs, with the summariser's own runs taken out of the session
 * counts.
 *
 * The summariser's `claude -p` is recorded by the Claude SessionEnd hook like
 * any other session — four or five a week — which inflated the volume and,
 * having no prose of its own, diluted the summarised share the alarm reads.
 * 065 counts sessions without them; those totals replace cairn_vitals' here
 * rather than inside it, for the reason 065's header gives. `withFiles` is
 * left alone: the summariser touches no file, so it never counted there.
 *
 * The signals are optional. Their failure is logged and carried as
 * `signalsError`, and assess() turns it into a warning — a monitor that goes
 * quietly blind reads as a healthy one, which is the bug CAIRN-288 is about.
 */
export const readVitalsFor = async (userId: string, hours = 24): Promise<Vitals> => {
  const [base, signals] = await Promise.all([
    (async () => {
      const { data, error } = await admin().rpc('cairn_vitals', { p_owner: userId, p_hours: hours })
      if (error) throw new Error(error.message)
      return data as unknown as Vitals
    })(),
    readSignalsFor(userId, hours).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[vitals] could not read signals', message)
      return message
    }),
  ])

  if (typeof signals === 'string') return { ...base, signals: null, signalsError: signals }

  return {
    ...base,
    sessions: {
      ...base.sessions,
      recent: signals.sessions.recent,
      recentSummarised: signals.sessions.recentSummarised,
      baseline: signals.sessions.baseline,
    },
    signals,
  }
}

/**
 * The vital signs as an agent gets them, which is the whole of the report and
 * not the half that happens to live in one aggregate.
 *
 * `readMemoryUseFor` had exactly one call site — the Vitals page — so every
 * number about whether AGENTS consult the memory was visible only to a person
 * with a browser open. The things that write knowledge here cannot open one.
 * That is the failure knowledge/gaps/route.ts names in its own header, "the
 * findings were visible only to a person who happened to click Map", repeated
 * one panel over; it is why this read carries the memory block. See CAIRN-254.
 *
 * Two round trips rather than one. The page already pays for both separately,
 * and folding memory into cairn_vitals would mean rewriting a function five
 * migrations have transformed in order to move a number that is already there.
 *
 * `memory` is null rather than fatal when the aggregate cannot be read: this
 * endpoint is the monitor, and a monitor that returns 500 because one of its
 * two questions is unanswerable has stopped answering the other one too.
 */
export type VitalsReport = Vitals & { memory: MemoryUse | null }

export const readVitals = async (actor: Actor, hours = 24): Promise<VitalsReport> => {
  const [vitals, memory] = await Promise.all([
    readVitalsFor(actor.userId, hours),
    readMemoryUseFor(actor.userId, hours).catch((error: unknown) => {
      console.error(
        '[vitals] could not read memory use',
        error instanceof Error ? error.message : error,
      )
      return null
    }),
  ])
  return { ...vitals, memory }
}

/**
 * The same read, cached, for the pages that show it.
 *
 * The aggregate takes ~45ms, which is fine once and wasteful on every
 * navigation — and a health summary five minutes stale is still a health
 * summary. The API route deliberately does not use this: a monitor asking the
 * question deserves the current answer.
 */
export const cachedVitals = (userId: string, hours = 24) =>
  unstable_cache(() => readVitalsFor(userId, hours), ['cairn-vitals', userId, String(hours)], {
    revalidate: 300,
  })()
