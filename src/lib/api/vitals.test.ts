import { describe, expect, it } from 'vitest'
import { assess, type Vitals } from './vitals'

/** A healthy week, which every test bends in exactly one direction. */
const healthy = (over: Partial<Vitals> = {}): Vitals => ({
  windowHours: 24,
  sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 6, baseline: 40, baselineWithFiles: 35 },
  tasks: { opened: 4, closed: 5, stalled: 1, held: 2 },
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

  it('does not tell a person to go and check their hooks', () => {
    // This shipped. `monty.torr@gmail.com has written nothing in 24h, against
    // 97 in the week before ... before investigating hooks or keys` — that is
    // the owner of the instance, 97 is a week of his own clicks in the web UI,
    // and he has neither hooks nor keys. `actorLabel` gives a human their
    // display name unqualified, so people land in this list looking exactly
    // like a runtime that has gone quiet.
    const v = healthy({
      agents: [
        { agent: 'claude-code · Cal', actorType: 'agent', recent: 40, baseline: 300 },
        { agent: 'Cal', actorType: 'human', recent: 0, baseline: 97 },
      ],
    })

    expect(codes(v)).not.toContain('agent-silent')
  })

  it('still reports a runtime that has gone quiet beside that person', () => {
    // The cost of the false positive was never the noise: openclaw wrote 793
    // times last week and nothing in 24h, and it was sitting in the same list
    // as a warning about a human. The quiet runtime is the whole point.
    const v = healthy({
      agents: [
        { agent: 'claude-code · Cal', actorType: 'agent', recent: 40, baseline: 300 },
        { agent: 'openclaw · Cal', actorType: 'agent', recent: 0, baseline: 793 },
        { agent: 'Cal', actorType: 'human', recent: 0, baseline: 97 },
      ],
    })

    const silent = assess(v).filter((f) => f.code === 'agent-silent')
    expect(silent).toHaveLength(1)
    expect(silent[0]?.message).toContain('openclaw · Cal')
    expect(silent[0]?.message).not.toContain('97')
  })

  it('treats a writer of unknown type as a runtime', () => {
    // A payload from a server that predates the column is all runtimes as far
    // as anybody knew. Silently dropping every check on an older server is
    // worse than the false positive this removes.
    const v = healthy({ agents: [{ agent: 'openclaw', recent: 0, baseline: 793 }] })
    expect(codes(v)).toContain('agent-silent')
  })
})
