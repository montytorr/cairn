import { describe, expect, it } from 'vitest'
import { groupByDay } from './session-grouping'

describe('groupByDay', () => {
  it('keeps a run of same-day rows in one group', () => {
    const rows = [
      { id: 1, endedAt: '2026-09-11T10:00:00Z' },
      { id: 2, endedAt: '2026-09-11T08:00:00Z' },
      // Well clear of the Europe/Paris day boundary, unlike 22:00Z, which is
      // already past midnight in Paris during CEST.
      { id: 3, endedAt: '2026-09-10T12:00:00Z' },
    ]
    const groups = groupByDay(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.rows.map((r) => r.id)).toEqual([1, 2])
    expect(groups[1]?.rows.map((r) => r.id)).toEqual([3])
  })

  it('does not merge two separated runs of the same day', () => {
    // Rows are assumed newest-first; a linear pass must not look ahead, so a
    // day that reappears later (should not happen given that ordering, but
    // is cheap to keep correct regardless) starts a new group.
    const rows = [
      { id: 1, endedAt: '2026-09-11T10:00:00Z' },
      { id: 2, endedAt: '2026-09-10T10:00:00Z' },
      { id: 3, endedAt: '2026-09-11T09:00:00Z' },
    ]
    expect(groupByDay(rows)).toHaveLength(3)
  })

  it('gives a session with no end time its own labelled bucket', () => {
    const groups = groupByDay([{ id: 1, endedAt: null }])
    expect(groups[0]?.day).toBe('No end time recorded')
  })
})
