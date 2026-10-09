import { describe, expect, it } from 'vitest'
import { BODY_BUDGET, looksLikeDigestClip } from './digest'

const long = 'a'.repeat(BODY_BUDGET + 500)

describe('looksLikeDigestClip', () => {
  it('flags the digest clip and an edit of it', () => {
    expect(looksLikeDigestClip(`${long.slice(0, BODY_BUDGET)}…`, long)).toBe(true)
    expect(looksLikeDigestClip(`b${long.slice(1, BODY_BUDGET)}…`, long)).toBe(true)
    expect(looksLikeDigestClip(`${long.slice(0, BODY_BUDGET)}…\n`, long)).toBe(true)
  })

  it('accepts a full edited body', () => {
    expect(looksLikeDigestClip(`${long}\n\nmore`, long)).toBe(false)
    expect(looksLikeDigestClip(`${long.slice(0, 900)}`, long)).toBe(false)
  })

  it('accepts a body ending in an ellipsis when the stored one fits the budget', () => {
    expect(looksLikeDigestClip('to be continued…', 'a'.repeat(BODY_BUDGET))).toBe(false)
    expect(looksLikeDigestClip('to be continued…', null)).toBe(false)
  })
})
