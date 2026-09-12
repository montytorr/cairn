import { describe, expect, it } from 'vitest'
import { bind, normalizeDatabaseValue } from './client'

describe('normalizeDatabaseValue', () => {
  it('preserves the former PostgREST timestamp contract for nested results', () => {
    const at = new Date('2026-09-12T07:04:18.535Z')

    expect(normalizeDatabaseValue({ at, nested: [{ ended_at: at }], value: 3 })).toEqual({
      at: '2026-09-12T07:04:18.535Z',
      nested: [{ ended_at: '2026-09-12T07:04:18.535Z' }],
      value: 3,
    })
  })
})

describe('bind', () => {
  const json = new Set(['sessions.files', 'task_activity_events.data'])

  it('serialises an array bound for a json column', () => {
    // Left alone, node-postgres writes the Postgres array literal {a,b},
    // which jsonb rejects — so every session that touched a file failed to
    // record at all.
    expect(bind('sessions', 'files', ['src/a.ts', 'src/b.ts'], json)).toBe('["src/a.ts","src/b.ts"]')
  })

  it('serialises an EMPTY array bound for a json column', () => {
    // The quiet half of the same bug: [] became the literal {}, which is
    // valid JSON for an *object*, so it was stored without complaint and the
    // column stopped holding arrays.
    expect(bind('sessions', 'files', [], json)).toBe('[]')
  })

  it('serialises an object bound for a json column', () => {
    expect(bind('task_activity_events', 'data', { reason: 'reconcile' }, json)).toBe(
      '{"reason":"reconcile"}',
    )
  })

  it('leaves a real Postgres array alone', () => {
    // task_refs is text[], and an array literal is exactly right for it.
    expect(bind('sessions', 'task_refs', ['AT-1', 'AT-2'], json)).toEqual(['AT-1', 'AT-2'])
  })

  it('passes scalars, dates and null through untouched', () => {
    const now = new Date()
    expect(bind('sessions', 'files', null, json)).toBeNull()
    expect(bind('sessions', 'tool_calls', 42, json)).toBe(42)
    expect(bind('sessions', 'started_at', now, json)).toBe(now)
  })
})
