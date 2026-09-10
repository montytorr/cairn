import { describe, expect, it } from 'vitest'
import { distinctiveTerms, widenedQuery } from './search'

describe('distinctiveTerms', () => {
  it('keeps the words worth matching on', () => {
    expect(distinctiveTerms('duplicate AI decision events per trade')).toEqual([
      'duplicate',
      'decision',
      'events',
      'trade',
    ])
  })

  it('drops short words and stopwords in both languages', () => {
    // The corpus is bilingual, so French stopwords matter as much as English.
    expect(distinctiveTerms('les erreurs dans le lint pour que')).toEqual(['erreurs', 'lint'])
  })

  it('deduplicates', () => {
    expect(distinctiveTerms('cache cache invalidation cache')).toEqual(['cache', 'invalidation'])
  })

  it('caps the term count so the OR query cannot match everything', () => {
    const many = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    expect(distinctiveTerms(many)).toHaveLength(8)
  })
})

describe('widenedQuery', () => {
  it('ORs the distinctive terms', () => {
    expect(widenedQuery('pagination missing on yima candidates')).toBe(
      'pagination OR missing OR yima OR candidates',
    )
  })

  it('returns null when there is nothing to widen', () => {
    // One term ORed with itself is just the original query; widening it would
    // spend a second round trip for the same result.
    expect(widenedQuery('supavisor')).toBeNull()
    expect(widenedQuery('a of to')).toBeNull()
  })
})
