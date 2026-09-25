import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
}))

import { unusedKnowledge, unusedWindow } from './knowledge-use'

describe('unusedKnowledge', () => {
  beforeEach(() => mocks.query.mockReset())

  it('ranks never-recalled entries before applying the result limit', async () => {
    const ranked = [{ slug: 'never-recalled', title: 'Never recalled',
      created_at: new Date(Date.UTC(2020, 0, 1)), last_recalled_at: null }]
    mocks.query.mockResolvedValueOnce({ rows: ranked })

    await expect(unusedKnowledge(30, 1)).resolves.toMatchObject([{ lastRecalled: null }])

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/order by last_recalled_at asc nulls first, created_at asc, id asc\s+limit \$2/i)
    // Both halves are cut at the limit before they are merged.
    expect(sql.match(/limit \$2/g)).toHaveLength(3)
    expect(params[1]).toBe(1)
  })

  it('never recounts all-time history per request', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    await unusedKnowledge(30, 1)
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]]
    // 062 keeps knowledge_recall_state; an unbounded aggregate over
    // search_events/knowledge_reads is exactly what it replaced.
    expect(sql).not.toMatch(/knowledge_recall_counts|search_events|knowledge_reads|-infinity/i)
    expect(sql).toMatch(/knowledge_recall_state/)
  })
})

describe('unusedWindow', () => {
  beforeEach(() => mocks.query.mockReset())

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000)

  it('says the store is too young instead of letting an empty list read as "all used"', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ oldest: daysAgo(14) }] })
    const window = await unusedWindow(30)
    expect(window.storeAgeDays).toBe(14)
    expect(window.note).toContain('younger than the 30-day window')
    expect(window.note).toContain('--unused 13')
  })

  it('says nothing once the store is old enough', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ oldest: daysAgo(45) }] })
    await expect(unusedWindow(30)).resolves.toEqual({ storeAgeDays: 45 })
  })

  it('treats an empty store as having no age', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ oldest: null }] })
    await expect(unusedWindow(30)).resolves.toEqual({ storeAgeDays: null })
  })
})
