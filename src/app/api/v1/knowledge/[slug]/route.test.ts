import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getKnowledge: vi.fn(),
  recordKnowledgeRead: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/knowledge', () => ({
  getKnowledge: mocks.getKnowledge,
  updateKnowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
}))

vi.mock('@/lib/api/search-events', () => ({
  recordKnowledgeRead: mocks.recordKnowledgeRead,
  recordSearch: vi.fn(),
}))

vi.mock('@/lib/api/activity', () => ({ recordActivity: vi.fn() }))

import { GET } from './route'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  // Unique per test run so the shared in-process rate limiter cannot interfere.
  rateKey: `knowledge-read-${Math.random()}`,
  sessionId: null,
}

const read = (slug: string, headers: Record<string, string> = {}) =>
  GET(new Request(`https://cairn.example.test/api/v1/knowledge/${slug}`, { headers }), {
    params: Promise.resolve({ slug }),
  })

const entry = {
  id: 'k-1',
  slug: 'supabase-connection-pooling',
  title: 'Supabase connection pooling',
  body: 'Use the pooler port.',
}

/**
 * `cairn know <slug>` is the single path that most directly answers "do agents
 * call knowledge when they need it", and it read and returned with no record of
 * having happened. recordSearch fired only from /api/v1/search.
 */
describe('GET /api/v1/knowledge/[slug] recall telemetry', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.getKnowledge.mockReset()
    mocks.recordKnowledgeRead.mockReset().mockResolvedValue(undefined)
  })

  it('records a hit, and still returns the entry', async () => {
    mocks.getKnowledge.mockResolvedValue(entry)

    const response = await read('supabase-connection-pooling')

    expect(response.status).toBe(200)
    expect(mocks.recordKnowledgeRead).toHaveBeenCalledWith(
      actor,
      'supabase-connection-pooling',
      true,
      { sweep: false },
    )
  })

  /**
   * The miss is the valuable one: an agent asking for a slug believed that fact
   * existed, so a 404 here is a dangling reference (CAIRN-253) caught as it is
   * followed. It must be a recorded event, not merely a missing one.
   */
  it('records a miss distinguishably, and still 404s', async () => {
    mocks.getKnowledge.mockResolvedValue(null)

    const response = await read('a-fact-that-was-never-written')

    expect(response.status).toBe(404)
    expect(mocks.recordKnowledgeRead).toHaveBeenCalledWith(
      actor,
      'a-fact-that-was-never-written',
      false,
      { sweep: false },
    )
  })

  it('passes on a read that says it is part of a sweep, so it is kept out of recall', async () => {
    mocks.getKnowledge.mockResolvedValue(entry)

    await read('supabase-connection-pooling', { 'X-Cairn-Read': 'sweep' })

    expect(mocks.recordKnowledgeRead).toHaveBeenCalledWith(
      actor,
      'supabase-connection-pooling',
      true,
      { sweep: true },
    )
  })

  it('records the miss before the 404 short-circuits the handler', async () => {
    mocks.getKnowledge.mockResolvedValue(null)

    await read('another-guess')

    // The bug this guards against is an early `return fail(...)` that leaves
    // the instrumentation behind it unreachable — which is exactly how the
    // miss, the informative half, would go unrecorded.
    expect(mocks.recordKnowledgeRead).toHaveBeenCalledTimes(1)
  })

  it('does not record a read the caller was never allowed to make', async () => {
    mocks.authenticate.mockResolvedValue(null)

    const response = await read('supabase-connection-pooling')

    expect(response.status).toBe(401)
    expect(mocks.recordKnowledgeRead).not.toHaveBeenCalled()
  })
})
