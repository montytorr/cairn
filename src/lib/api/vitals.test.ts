import { describe, expect, it } from 'vitest'
import { assess, type Vitals } from './vitals'

/** A healthy week, which every test bends in exactly one direction. */
const healthy = (over: Partial<Vitals> = {}): Vitals => ({
  windowHours: 24,
  sessions: { recent: 6, recentWithFiles: 5, baseline: 40, baselineWithFiles: 35 },
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
    const v = healthy({ sessions: { recent: 0, recentWithFiles: 0, baseline: 40, baselineWithFiles: 35 } })
    expect(codes(v)).toContain('no-sessions')
  })

  it('does not cry outage when the week before was also quiet', () => {
    // A new install, or a fortnight off. Zero against zero is not a signal.
    const v = healthy({ sessions: { recent: 0, recentWithFiles: 0, baseline: 0, baselineWithFiles: 0 } })
    expect(codes(v)).not.toContain('no-sessions')
  })

  it('catches the jsonb bug, where the total never dropped', () => {
    // Sessions kept being written; only the ones naming a file were rejected,
    // so nothing looked wrong for two days.
    const v = healthy({ sessions: { recent: 6, recentWithFiles: 0, baseline: 40, baselineWithFiles: 35 } })
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
      sessions: { recent: 6, recentWithFiles: 5, baseline: 40, baselineWithFiles: 35 },
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
      sessions: { recent: 0, recentWithFiles: 0, baseline: 40, baselineWithFiles: 35 },
      tasks: { opened: 4, closed: 5, stalled: 9, held: 2 },
    })
    const bySeverity = assess(v)
    expect(bySeverity.find((f) => f.code === 'no-sessions')?.severity).toBe('alarm')
    expect(bySeverity.find((f) => f.code === 'stalled-work')?.severity).toBe('warning')
  })
})
