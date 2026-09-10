import { beforeEach, describe, expect, it } from 'vitest'
import { __test } from './attachments'

describe('signed URL origin rewriting', () => {
  beforeEach(() => {
    process.env.SUPABASE_INTERNAL_URL = 'http://cairn-supabase-api-gw:8000'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://tasks.example.com/supabase'
  })

  /**
   * Regression guard: Supabase signs URLs against the client's own base, which
   * server-side is an internal Docker hostname. Handing that to a browser
   * produces a link nothing can resolve.
   */
  it('swaps an internal origin for the public one', () => {
    expect(__test.toPublicOrigin('http://cairn-supabase-api-gw:8000/storage/v1/object/sign/a?token=x')).toBe(
      'https://tasks.example.com/supabase/storage/v1/object/sign/a?token=x',
    )
  })

  it('leaves an already-public URL alone', () => {
    expect(__test.toPublicOrigin('https://tasks.example.com/supabase/storage/v1/x')).toBe(
      'https://tasks.example.com/supabase/storage/v1/x',
    )
  })

  it('returns null for a missing URL', () => {
    expect(__test.toPublicOrigin(undefined)).toBeNull()
  })
})
