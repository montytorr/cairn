import { describe, expect, it } from 'vitest'
import { normalizeDatabaseValue } from './client'

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
