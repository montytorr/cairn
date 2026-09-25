import { describe, expect, it } from 'vitest'
import {
  assess,
  assessSignals,
  isMaintenance,
  REAPER_REACH_MINUTES,
  type RuntimeHost,
  type Vitals,
  type VitalsSignals,
} from './vitals'

/** A healthy week, which every test bends in exactly one direction. */
const healthy = (over: Partial<Vitals> = {}): Vitals => ({
  windowHours: 24,
  sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 6, baseline: 40, baselineWithFiles: 35 },
  tasks: { opened: 4, closed: 5, stalled: 1, held: 2, closedWithoutTrace: 0 },
  autoReleased: 0,
  knowledgeWritten: 2,
  agents: [
    { agent: 'claude-code', recent: 40, baseline: 300 },
    { agent: 'codex', recent: 12, baseline: 90 },
  ],
  ...over,
})

const codes = (v: Vitals) => assess(v).map((f) => f.code)

describe('assess', () => {
  it('says nothing about a healthy window', () => {
    expect(assess(healthy())).toEqual([])
  })

  it('catches the two-day session outage', () => {
    const v = healthy({ sessions: { recent: 0, recentWithFiles: 0, recentSummarised: 0, baseline: 40, baselineWithFiles: 35 } })
    expect(codes(v)).toContain('no-sessions')
  })

  it('reports the outage without claiming to know its cause', () => {
    // The message used to end "The session hooks are not running, or cannot
    // write." It was wrong both times it mattered: once the runtimes were out
    // of tokens, once the hooks fired fine and the sessions had simply never
    // ended. A count of zero cannot tell a runtime with nothing to say from
    // one that cannot speak, so the alarm states what it saw and names the
    // command that separates them.
    const v = healthy({ sessions: { recent: 0, recentWithFiles: 0, recentSummarised: 0, baseline: 40, baselineWithFiles: 35 } })
    const message = assess(v).find((f) => f.code === 'no-sessions')?.message ?? ''
    expect(message).not.toMatch(/hooks are not running/)
    expect(message).toContain('--dry-run')
  })

  it('does not cry outage when the week before was also quiet', () => {
    // A new install, or a fortnight off. Zero against zero is not a signal.
    const v = healthy({ sessions: { recent: 0, recentWithFiles: 0, recentSummarised: 0, baseline: 0, baselineWithFiles: 0 } })
    expect(codes(v)).not.toContain('no-sessions')
  })

  it('does not tell a person their hooks may be broken', () => {
    // The owner of the instance writes through the web UI, so he appears in
    // this list beside the runtimes. He has no hooks and no keys.
    const v = healthy({
      agents: [
        { agent: 'claude-code', actorType: 'agent', recent: 208, baseline: 1641 },
        { agent: 'openclaw', actorType: 'agent', recent: 0, baseline: 1045 },
        { agent: 'monty', actorType: 'human', recent: 0, baseline: 97 },
      ],
    })
    const silent = assess(v).filter((f) => f.code === 'agent-silent')
    expect(silent).toHaveLength(1)
    expect(silent[0]?.message).toContain('openclaw')
  })

  it('still warns when the server is too old to say what an actor is', () => {
    // A payload from before migration 050 carries no actorType. Everything in
    // that list was a runtime as far as anyone knew, and dropping the check
    // there would be worse than the false positive it removes.
    const v = healthy({ agents: [{ agent: 'openclaw', recent: 0, baseline: 1045 }] })
    expect(codes(v)).toContain('agent-silent')
  })

  it('counts work that was closed with no trace that anyone was on it', () => {
    // CAIRN-135 measured 36% and nothing has recomputed it since.
    const v = healthy({ tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedWithoutTrace: 3 } })
    const f = assess(v).find((x) => x.code === 'closed-without-trace')
    expect(f?.severity).toBe('warning')
    expect(f?.message).toContain('3 of 8')
  })

  it('does not cry about one of two', () => {
    // A floor under the ratio, because a small week is not a pattern and a
    // warning that fires on noise teaches people to skip the line.
    const v = healthy({ tasks: { opened: 1, closed: 2, stalled: 1, held: 2, closedWithoutTrace: 1 } })
    expect(codes(v)).not.toContain('closed-without-trace')
  })

  it('says nothing when the server is too old to send the number', () => {
    // Absent is not zero and is not a problem either; a check that cannot see
    // the number must not invent one. A server on 051 sends closedUnclaimed,
    // which counted a different population under a different question, so the
    // rename is what stops the new sentence being printed over the old number.
    const v = healthy({ tasks: { opened: 4, closed: 8, stalled: 1, held: 2 } })
    expect(codes(v)).not.toContain('closed-without-trace')
    const stale = healthy({
      tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedUnclaimed: 8 },
    } as unknown as Partial<Vitals>)
    expect(assess(stale)).toEqual([])
  })

  it('no longer says the tasks it counts were never claimed', () => {
    // The wording is the bug CAIRN-251 filed: "Nothing recorded that anyone was
    // working them" was false of nine of the ten tasks it was printed about,
    // which had moved to in-review hours earlier with commits against them.
    const v = healthy({ tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedWithoutTrace: 3 } })
    const message = assess(v).find((f) => f.code === 'closed-without-trace')?.message ?? ''
    expect(message).not.toMatch(/never claimed/)
    expect(message).toContain('nothing recorded in between')
    expect(message).toContain('no status move')
    expect(message).toContain('no commit')
  })

  it('catches the jsonb bug, where the total never dropped', () => {
    // Sessions kept being written; only the ones naming a file were rejected,
    // so nothing looked wrong for two days.
    const v = healthy({ sessions: { recent: 6, recentWithFiles: 0, recentSummarised: 6, baseline: 40, baselineWithFiles: 35 } })
    expect(codes(v)).toContain('sessions-without-files')
  })

  it('catches one agent going silent while the others carry on', () => {
    const v = healthy({
      agents: [
        { agent: 'claude-code', recent: 40, baseline: 300 },
        { agent: 'codex', recent: 0, baseline: 90 },
      ],
    })
    const finding = assess(v).find((f) => f.code === 'agent-silent')
    expect(finding?.message).toContain('codex')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('idle runtime')
  })

  it('ignores an agent that barely wrote in the baseline either', () => {
    // 10 writes a week is under one a day; silence for a day means nothing.
    const v = healthy({ agents: [{ agent: 'occasional', recent: 0, baseline: 10 }] })
    expect(codes(v)).not.toContain('agent-silent')
  })

  it('scales the baseline to the window rather than comparing raw counts', () => {
    // Over a week-long window, 90 baseline writes is the expectation, not 13.
    const v = healthy({
      windowHours: 168,
      agents: [{ agent: 'codex', recent: 0, baseline: 90 }],
      sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 6, baseline: 40, baselineWithFiles: 35 },
    })
    expect(codes(v)).toContain('agent-silent')
  })

  it('warns on work started and dropped, but only once it is a pattern', () => {
    expect(codes(healthy({ tasks: { opened: 4, closed: 5, stalled: 6, held: 2 } }))).toContain('stalled-work')
    expect(codes(healthy({ tasks: { opened: 4, closed: 5, stalled: 5, held: 2 } }))).not.toContain('stalled-work')
  })

  it('warns when claims are being abandoned', () => {
    expect(codes(healthy({ autoReleased: 5 }))).toContain('claims-abandoned')
  })

  it('warns when nothing is being closed, with enough sample to mean it', () => {
    expect(codes(healthy({ tasks: { opened: 5, closed: 0, stalled: 1, held: 2 } }))).toContain('nothing-closed')
    expect(codes(healthy({ tasks: { opened: 4, closed: 0, stalled: 1, held: 2 } }))).not.toContain('nothing-closed')
  })

  it('separates what is broken from what is merely untidy', () => {
    const v = healthy({
      sessions: { recent: 0, recentWithFiles: 0, recentSummarised: 0, baseline: 40, baselineWithFiles: 35 },
      tasks: { opened: 4, closed: 5, stalled: 9, held: 2 },
    })
    const bySeverity = assess(v)
    expect(bySeverity.find((f) => f.code === 'no-sessions')?.severity).toBe('alarm')
    expect(bySeverity.find((f) => f.code === 'stalled-work')?.severity).toBe('warning')
  })
})

describe('the summariser failing silently', () => {
  it('is an alarm when sessions are recorded and none is summarised', () => {
    // The shape this actually had: rows present, counts healthy, every one of
    // them half a session.
    const codes = assess(
      healthy({ sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 0, baseline: 40, baselineWithFiles: 35 } }),
    ).map((f) => f.code)
    expect(codes).toContain('sessions-without-summary')
  })

  it('stays quiet when even one was summarised', () => {
    // One is enough to prove the summariser is reachable; a session where the
    // model honestly found nothing to say is not a fault.
    const codes = assess(
      healthy({ sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 1, baseline: 40, baselineWithFiles: 35 } }),
    ).map((f) => f.code)
    expect(codes).not.toContain('sessions-without-summary')
  })

  it('stays quiet on a day too thin to judge', () => {
    const codes = assess(
      healthy({ sessions: { recent: 2, recentWithFiles: 2, recentSummarised: 0, baseline: 40, baselineWithFiles: 35 } }),
    ).map((f) => f.code)
    expect(codes).not.toContain('sessions-without-summary')
  })
})

/**
 * The blind spots CAIRN-282 found, each reading green while it failed. The
 * signals come from migration 065; a healthy set is bent one way per test.
 */
const NOW = Date.parse('2026-09-25T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const healthySignals = (over: Partial<VitalsSignals> = {}): VitalsSignals => ({
  windowHours: 24,
  sessions: {
    recent: 6,
    recentSummarised: 6,
    baseline: 40,
    baselineSummarised: 30,
    summariserRecent: 0,
    summariserBaseline: 0,
  },
  runtimes: [
    { runtime: 'claude', host: 'macos', recent: 6, recentSummarised: 5, baseline: 35, baselineSummarised: 28, lastSeenAt: hoursAgo(1) },
    { runtime: 'openclaw', host: 'linux', recent: 3, recentSummarised: 3, baseline: 21, baselineSummarised: 18, lastSeenAt: hoursAgo(2) },
  ],
  claims: { held: 2, quiet2h: 0, quiet24h: 0, quietest: [] },
  reaper: { releasedInWindow: 0, released7d: 2, lastReleaseAt: hoursAgo(50), maintenanceLastWriteAt: hoursAgo(50) },
  absentAgents: [],
  knowledge: { current: 424, neverVerified: 421, unverified30d: 422, verifiedInWindow: 0, lastVerifiedAt: hoursAgo(250) },
  ...over,
})

const withSignals = (signals: VitalsSignals | null, over: Partial<Vitals> = {}) =>
  healthy({ signals, ...over })

const signalCodes = (v: Vitals) => assessSignals(v, NOW).map((f) => f.code)

const quietClaim = (ref: string, hours: number | null) => ({
  ref,
  title: `task ${ref}`,
  claimedBy: 'openclaw · Dev',
  lastActivityAt: hours === null ? null : hoursAgo(hours),
  quietMinutes: hours === null ? null : Math.round(hours * 60),
})

describe('assessSignals', () => {
  it('says nothing about a healthy set', () => {
    expect(assessSignals(withSignals(healthySignals()), NOW)).toEqual([])
  })

  it('says nothing when the server cannot send signals at all', () => {
    // A payload from before 065 has no key; that is not a failure to report.
    expect(assessSignals(healthy(), NOW)).toEqual([])
  })

  it('reports signals that failed to read rather than reading as healthy', () => {
    const findings = assessSignals(withSignals(null, { signalsError: 'function does not exist' }), NOW)
    expect(findings.map((f) => f.code)).toEqual(['signals-unavailable'])
    expect(findings[0]?.message).toContain('function does not exist')
  })

  it('treats knowledge never verified as informational, not a finding', () => {
    // 421 of 424 on the day of the audit. No threshold is defensible yet.
    expect(signalCodes(withSignals(healthySignals()))).toEqual([])
  })

  describe('quiet claims', () => {
    it('warns about a claim nobody has touched for a day, naming it', () => {
      const v = withSignals(
        healthySignals({ claims: { held: 22, quiet2h: 17, quiet24h: 1, quietest: [quietClaim('BB-385', 168)] } }),
      )
      const f = assessSignals(v, NOW).find((x) => x.code === 'claims-quiet')
      expect(f?.severity).toBe('warning')
      expect(f?.message).toContain('BB-385 (168h, openclaw · Dev)')
      expect(f?.message).toContain('17 of 22')
    })

    it('warns about three claims quiet for more than 2h', () => {
      const v = withSignals(
        healthySignals({
          claims: {
            held: 5,
            quiet2h: 3,
            quiet24h: 0,
            quietest: [quietClaim('A-1', 3), quietClaim('A-2', 2.5), quietClaim('A-3', 2.1)],
          },
        }),
      )
      expect(signalCodes(v)).toContain('claims-quiet')
    })

    it('stays quiet about one or two claims just past 2h', () => {
      const v = withSignals(
        healthySignals({
          claims: { held: 5, quiet2h: 2, quiet24h: 0, quietest: [quietClaim('A-1', 2.2), quietClaim('A-2', 2.1)] },
        }),
      )
      expect(signalCodes(v)).not.toContain('claims-quiet')
    })
  })

  describe('the reaper', () => {
    const stale = { held: 22, quiet2h: 17, quiet24h: 10, quietest: [quietClaim('BB-385', 168)] }
    const idle = { releasedInWindow: 0, released7d: 0, lastReleaseAt: null, maintenanceLastWriteAt: null }

    it('alarms when claims are past its reach and it released nothing in 7 days', () => {
      // The audit's shape: #0 every 30 minutes since 09-12 against 17 quiet claims.
      const v = withSignals(
        healthySignals({ claims: stale, reaper: { ...idle, lastReleaseAt: hoursAgo(13 * 24) } }),
      )
      const f = assessSignals(v, NOW).find((x) => x.code === 'reaper-idle')
      expect(f?.severity).toBe('alarm')
      expect(f?.message).toContain('168h')
      expect(f?.message).toContain('312h ago')
      expect(f?.message).toContain('maintenance identity last wrote never')
      expect(signalCodes(v)).not.toContain('maintenance-silent')
    })

    it('treats a claim with no activity ever recorded as past its reach', () => {
      const v = withSignals(
        healthySignals({
          claims: { held: 1, quiet2h: 1, quiet24h: 1, quietest: [quietClaim('X-1', null)] },
          reaper: idle,
        }),
      )
      expect(signalCodes(v)).toContain('reaper-idle')
    })

    it('warns, not alarms, when it released this week but not in the window', () => {
      const v = withSignals(healthySignals({ claims: stale }))
      expect(signalCodes(v)).toContain('maintenance-silent')
      expect(signalCodes(v)).not.toContain('reaper-idle')
    })

    it('says nothing when no claim has been quiet long enough for it to act', () => {
      // Quiet for 2h30 is inside 120 minutes plus the 30-minute schedule.
      const v = withSignals(
        healthySignals({
          claims: { held: 1, quiet2h: 1, quiet24h: 0, quietest: [quietClaim('A-1', 2.5)] },
          reaper: idle,
        }),
      )
      expect(REAPER_REACH_MINUTES).toBe(180)
      expect(signalCodes(v)).not.toContain('reaper-idle')
      expect(signalCodes(v)).not.toContain('maintenance-silent')
    })

    it('reaches the banner, which shows alarms only', () => {
      const v = withSignals(healthySignals({ claims: stale, reaper: idle }))
      expect(assess(v).filter((f) => f.severity === 'alarm').map((f) => f.code)).toContain('reaper-idle')
    })
  })

  describe('the summariser per runtime and host', () => {
    const rt = (over: Partial<RuntimeHost>): RuntimeHost => ({
      runtime: 'openclaw',
      host: 'linux',
      recent: 8,
      recentSummarised: 8,
      baseline: 40,
      baselineSummarised: 30,
      lastSeenAt: hoursAgo(1),
      ...over,
    })

    it('warns at 1 of 16 when one success kept the old alarm green', () => {
      // 09-24: openclaw 0/8, codex 0/2, claude 1/6, against ~75% the week before.
      const v = withSignals(
        healthySignals({
          runtimes: [
            rt({ runtime: 'openclaw', recent: 8, recentSummarised: 0 }),
            rt({ runtime: 'codex', host: 'macos', recent: 2, recentSummarised: 0, baseline: 10, baselineSummarised: 8 }),
            rt({ runtime: 'claude', host: 'macos', recent: 6, recentSummarised: 1, baseline: 40, baselineSummarised: 32 }),
          ],
        }),
        { sessions: { recent: 16, recentWithFiles: 10, recentSummarised: 1, baseline: 90, baselineWithFiles: 70 } },
      )
      expect(codes(v)).not.toContain('sessions-without-summary')
      const f = assessSignals(v, NOW).find((x) => x.code === 'summariser-degraded')
      expect(f?.message).toContain('openclaw@linux 0/8')
      expect(f?.message).toContain('codex@macos 0/2')
      expect(f?.message).toContain('claude@macos 1/6')
    })

    it('warns below 50% with three sessions and no baseline', () => {
      const v = withSignals(
        healthySignals({ runtimes: [rt({ recent: 4, recentSummarised: 1, baseline: 0, baselineSummarised: 0 })] }),
      )
      expect(signalCodes(v)).toContain('summariser-degraded')
    })

    it('does not judge a runtime by one session against its baseline', () => {
      const v = withSignals(
        healthySignals({ runtimes: [rt({ recent: 1, recentSummarised: 0, baseline: 6, baselineSummarised: 6 })] }),
      )
      expect(signalCodes(v)).not.toContain('summariser-degraded')
    })

    it('accepts a runtime that always summarised little, at its own rate', () => {
      const v = withSignals(
        healthySignals({ runtimes: [rt({ recent: 2, recentSummarised: 1, baseline: 40, baselineSummarised: 16 })] }),
      )
      expect(signalCodes(v)).not.toContain('summariser-degraded')
    })
  })

  describe('session volume per runtime and host', () => {
    const rt = (over: Partial<RuntimeHost>): RuntimeHost => ({
      runtime: 'claude',
      host: 'macos',
      recent: 8,
      recentSummarised: 6,
      baseline: 50,
      baselineSummarised: 40,
      lastSeenAt: hoursAgo(1),
      ...over,
    })

    it('flags a runtime present last week and absent now', () => {
      // openclaw's scheduled runs stopped on 09-20 inside a healthy-looking total.
      const v = withSignals(
        healthySignals({
          runtimes: [
            rt({}),
            rt({ runtime: 'openclaw', host: 'linux', recent: 0, recentSummarised: 0, baseline: 70, lastSeenAt: hoursAgo(30) }),
          ],
        }),
      )
      const f = assessSignals(v, NOW).find((x) => x.code === 'runtime-quiet')
      expect(f?.message).toContain('openclaw@linux 0 in 24h, about 10 expected')
      expect(f?.message).not.toContain('claude@macos')
    })

    it('flags a runtime well under a third of its usual volume, not only at zero', () => {
      const v = withSignals(healthySignals({ runtimes: [rt({ recent: 2, recentSummarised: 2, baseline: 140 })] }))
      expect(signalCodes(v)).toContain('runtime-quiet')
    })

    it('does not flag a runtime too rarely used to expect one today', () => {
      const v = withSignals(
        healthySignals({ runtimes: [rt({ runtime: 'codex', recent: 0, recentSummarised: 0, baseline: 3, baselineSummarised: 3 })] }),
      )
      expect(signalCodes(v)).not.toContain('runtime-quiet')
    })

    it('names a runtime absent for the window and the week before', () => {
      const v = withSignals(
        healthySignals({
          runtimes: [
            rt({ runtime: 'codex', host: 'linux', recent: 0, recentSummarised: 0, baseline: 0, baselineSummarised: 0, lastSeenAt: hoursAgo(24 * 12) }),
          ],
          absentAgents: [{ agent: 'codex · Dev', lastSeenAt: hoursAgo(24 * 10) }],
        }),
      )
      const f = assessSignals(v, NOW).find((x) => x.code === 'runtime-absent')
      expect(f?.message).toContain('codex@linux sessions (last 288h ago)')
      expect(f?.message).toContain('codex · Dev writes (last 240h ago)')
    })
  })

  it('does not call the maintenance identity a silent runtime', () => {
    // It writes only when it releases; the reaper checks judge it instead.
    const v = healthy({
      agents: [{ agent: 'maintenance · Dev', actorType: 'agent', recent: 0, baseline: 40 }],
    })
    expect(codes(v)).not.toContain('agent-silent')
    expect(isMaintenance('maintenance')).toBe(true)
    expect(isMaintenance('claude-code · Dev')).toBe(false)
  })
})
