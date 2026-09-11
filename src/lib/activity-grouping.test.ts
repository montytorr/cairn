import { describe, expect, it } from 'vitest'
import { groupActivity } from './activity-grouping'
import type { ActivityRow } from '@/lib/api/activity-feed'

const row = (o: Partial<ActivityRow> = {}): ActivityRow => ({
  kind: 'event',
  at: '2026-09-11T13:28:00Z',
  actor: 'openclaw',
  project_key: 'AT',
  ref: 'AT-396',
  title: 'Analyze CDE external context',
  detail: 'status_changed',
  ...o,
})

describe('groupActivity', () => {
  it('collapses a run of events on one task into a single entry', () => {
    const grouped = groupActivity([
      row({ detail: 'status_changed' }),
      row({ detail: 'resolved' }),
      row({ detail: 'created' }),
      row({ kind: 'task', detail: 'improvement' }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.merged).toBe(4)
    expect(grouped[0]?.details).toEqual(['status_changed', 'resolved', 'created', 'improvement'])
  })

  it('keeps the newest row as the entry, since the feed is newest-first', () => {
    const grouped = groupActivity([
      row({ at: '2026-09-11T13:28:09Z', detail: 'resolved' }),
      row({ at: '2026-09-11T13:28:01Z', detail: 'created' }),
    ])
    expect(grouped[0]?.at).toBe('2026-09-11T13:28:09Z')
  })

  it('never merges a note into the task events around it', () => {
    const grouped = groupActivity([
      row({ detail: 'created' }),
      row({ kind: 'note', title: 'Tried raising pool_size, no change', detail: 'attempt' }),
      row({ detail: 'resolved' }),
    ])
    expect(grouped).toHaveLength(3)
  })

  it('does not merge the same event across different tasks', () => {
    const grouped = groupActivity([
      row({ ref: 'AT-396' }),
      row({ ref: 'AT-395', title: 'Analyze CIFR external context' }),
    ])
    expect(grouped).toHaveLength(2)
  })

  it('deduplicates a detail repeated within one run', () => {
    const grouped = groupActivity([row({ detail: 'created' }), row({ detail: 'created' })])
    expect(grouped[0]?.details).toEqual(['created'])
    expect(grouped[0]?.merged).toBe(2)
  })
})
