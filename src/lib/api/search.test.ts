import { describe, expect, it } from 'vitest'
import { distinctiveTerms, widenedTerms } from './search'

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

describe('widenedTerms', () => {
  it('returns the terms individually, not pre-joined', () => {
    // The database ranks by how many DISTINCT terms a row matches, which
    // cannot be recovered from an already-ORed string.
    expect(widenedTerms('pagination missing on yima candidates')).toEqual([
      'pagination',
      'missing',
      'yima',
      'candidates',
    ])
  })

  it('returns null when there is nothing to widen', () => {
    expect(widenedTerms('supavisor')).toBeNull()
    expect(widenedTerms('a of to')).toBeNull()
  })
})

describe('result refs must stay addressable', () => {
  /**
   * A search result's `ref` is what an agent passes straight to `cairn show`.
   * Preferring the imported identifier there returns things like "BBTRADE-373",
   * which looks like a ref and 404s, because no project has that key. The
   * imported id belongs in its own field.
   */
  const toRef = (row: { project_key: string; number: number }) =>
    `${row.project_key}-${row.number}`

  it('builds the ref from the project key and number', () => {
    expect(toRef({ project_key: 'TBV', number: 109 })).toBe('TBV-109')
  })

  it('is unaffected by an imported identifier', () => {
    const row = { project_key: 'TBV', number: 109, external_ref: 'BBTRADE-373' }
    expect(toRef(row)).toBe('TBV-109')
    expect(toRef(row)).not.toBe(row.external_ref)
  })
})
