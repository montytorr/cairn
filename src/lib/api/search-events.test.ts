import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({ from: mocks.from }),
}))

import { recordKnowledgeRead, recordSearch } from './search-events'
import type { Actor } from './auth'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: 'key-1',
  sessionId: null,
} as Actor

/** The row the insert was given, whichever table it went to. */
const inserted = () => mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>
const table = () => mocks.from.mock.calls[0]?.[0] as string

describe('recordSearch', () => {
  beforeEach(() => {
    mocks.insert.mockReset().mockResolvedValue({ data: null, error: null })
    mocks.from.mockReset().mockImplementation(() => ({ insert: mocks.insert }))
  })

  /**
   * Only `result_count` was ever stored, which makes "did the search return the
   * right fact" unanswerable in principle: a widened search that found the
   * right entry and a precise one that found the wrong entry are the same row.
   */
  it('stores which entries came back, in rank order', async () => {
    await recordSearch(actor, 'supavisor pool timeouts', null, 3, false, [
      'CAIRN-131',
      'pgbouncer-vs-supavisor',
      'CAIRN-88',
    ])

    expect(inserted().returned_slugs).toEqual([
      'CAIRN-131',
      'pgbouncer-vs-supavisor',
      'CAIRN-88',
    ])
  })

  /**
   * An empty array is a claim — "the search ran and returned nothing" — and
   * must be stored as one. NULL is reserved for rows written before the column
   * existed, which say nothing either way.
   */
  it('distinguishes "returned nothing" from "we did not record it"', async () => {
    await recordSearch(actor, 'a subject cairn has never heard of', null, 0, true, [])

    expect(inserted().returned_slugs).toEqual([])
    expect(inserted().returned_slugs).not.toBeNull()
  })

  it('caps the list so one search cannot write an unbounded row', async () => {
    const many = Array.from({ length: 100 }, (_, i) => `CAIRN-${i}`)
    await recordSearch(actor, 'everything', null, many.length, true, many)

    const stored = inserted().returned_slugs as string[]
    expect(stored).toHaveLength(50)
    // The head of the ranked list, not an arbitrary slice of it.
    expect(stored[0]).toBe('CAIRN-0')
  })

  it('still records the rest of the event when there are no results at all', async () => {
    await recordSearch(actor, 'kraken websocket reconnect', ['knowledge'], 0, true, [])

    expect(table()).toBe('search_events')
    expect(inserted()).toMatchObject({
      actor_id: actor.actorId,
      query: 'kraken websocket reconnect',
      kinds: ['knowledge'],
      result_count: 0,
      widened: true,
    })
  })

  it('never fails the search it is measuring', async () => {
    mocks.insert.mockRejectedValue(new Error('search_events is gone'))
    await expect(recordSearch(actor, 'anything', null, 1, false, ['CAIRN-1'])).resolves.toBeUndefined()
  })
})

describe('recordKnowledgeRead', () => {
  beforeEach(() => {
    mocks.insert.mockReset().mockResolvedValue({ data: null, error: null })
    mocks.from.mockReset().mockImplementation(() => ({ insert: mocks.insert }))
  })

  it('records a direct recall by slug, which nothing recorded before', async () => {
    await recordKnowledgeRead(actor, 'supabase-connection-pooling', true)

    expect(table()).toBe('knowledge_reads')
    expect(inserted()).toMatchObject({
      owner_user_id: 'user-1',
      actor_id: actor.actorId,
      slug: 'supabase-connection-pooling',
      hit: true,
    })
  })

  it('marks a declared sweep, and only then', async () => {
    await recordKnowledgeRead(actor, 'some-fact', true, { sweep: true })
    expect(inserted()).toMatchObject({ slug: 'some-fact', hit: true, sweep: true })

    await recordKnowledgeRead(actor, 'some-fact', true)
    // Absent rather than false, so the database default and the rate rule decide.
    expect(mocks.insert.mock.calls[1]?.[0]).not.toHaveProperty('sweep')
  })

  /**
   * The valuable half. A miss on a guessed slug is a dangling reference being
   * followed live, so it has to be a row that says "asked for, not held" —
   * never merely an absent row, which is indistinguishable from nobody asking.
   */
  it('records a miss as a row, not as an absence', async () => {
    await recordKnowledgeRead(actor, 'a-fact-that-was-never-written', false)

    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(inserted()).toMatchObject({ slug: 'a-fact-that-was-never-written', hit: false })
  })

  /**
   * The lookup itself normalises before querying, so the telemetry has to as
   * well — a miss that cannot be joined against `knowledge.slug` measures
   * nothing.
   */
  it('normalises the slug the way the lookup does', async () => {
    await recordKnowledgeRead(actor, '  Supabase_Connection_Pooling  ', false)

    expect(inserted().slug).toBe('supabase-connection-pooling')
  })

  it('never fails the read it is measuring', async () => {
    mocks.insert.mockRejectedValue(new Error('knowledge_reads is gone'))
    await expect(recordKnowledgeRead(actor, 'anything', true)).resolves.toBeUndefined()
  })
})

/**
 * Kept out of search_events on purpose: `widened` is meaningless for a slug
 * lookup, and `result_count = 0` means the opposite there of what it means for
 * a two-pass search. Writing reads into search_events would move `searches`,
 * `zeroResults` and the widening rate, which are the numbers 024/026/027 exist
 * to produce. See migration 053.
 */
describe('the two event kinds stay in separate tables', () => {
  beforeEach(() => {
    mocks.insert.mockReset().mockResolvedValue({ data: null, error: null })
    mocks.from.mockReset().mockImplementation(() => ({ insert: mocks.insert }))
  })

  it('does not write a direct read into search_events', async () => {
    await recordKnowledgeRead(actor, 'some-fact', false)

    expect(mocks.from).not.toHaveBeenCalledWith('search_events')
    expect(inserted()).not.toHaveProperty('widened')
    expect(inserted()).not.toHaveProperty('result_count')
  })
})
