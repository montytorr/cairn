import { describe, expect, it } from 'vitest'
import { knowledgeCreate, knowledgeUpdate, SLUG_PATTERN, slugify } from './knowledge'

/**
 * The slug is the only name a fact has. `cairn know <subject>` decides between
 * fetching an entry and searching for one by testing the subject against
 * `SLUG_PATTERN`, and knowledge bodies cross-reference each other by slug —
 * so the shape of this string is the difference between following a reference
 * and getting a handful of loose search hits with no sign you missed.
 */
describe('knowledge slugs', () => {
  it('turns a claim into a hyphenated identifier', () => {
    expect(slugify('Zod .partial() keeps defaults')).toBe('zod-partial-keeps-defaults')
  })

  it('strips accents rather than dropping the words carrying them', () => {
    // The store is part French; "réessaye" must not become "r-essaye".
    expect(slugify('Le témoin réessaye')).toBe('le-temoin-reessaye')
  })

  it('never produces leading or trailing hyphens', () => {
    expect(slugify('  ...Session cookies!  ')).toBe('session-cookies')
  })

  it('separates with hyphens, never underscores', () => {
    // This is the whole reason 365 imported links resolve to nothing: the
    // bodies say `cache_warmup_race`, every real slug says
    // `cache-warmup-race`, and nothing reconciles the two.
    expect(slugify('cache warmup race')).not.toContain('_')
    expect(slugify('cache_warmup_race')).toBe('cache-warmup-race')
  })

  it('returns empty for a title with nothing sluggable in it, rather than a bare hyphen', () => {
    // The caller relies on this: an empty result is what makes it ask for
    // --slug instead of writing an entry called "-".
    expect(slugify('!!! ???')).toBe('')
  })
})

describe('SLUG_PATTERN — what `cairn know` treats as a slug rather than a query', () => {
  it('accepts the shape slugify produces', () => {
    expect(SLUG_PATTERN.test('cache-warmup-race')).toBe(true)
    expect(SLUG_PATTERN.test('proxy-buffer-defaults')).toBe(true)
  })

  it('rejects the underscore spelling, which is why following a link fell through to search', () => {
    // Not a defect in the pattern — a fact about it worth pinning down, since
    // an agent typing the underscore form gets a search that can miss
    // silently rather than a fetch that succeeds.
    expect(SLUG_PATTERN.test('cache_warmup_race')).toBe(false)
  })

  it('rejects anything with spaces, so a real query is never mistaken for a slug', () => {
    expect(SLUG_PATTERN.test('postgrest ambiguous embed')).toBe(false)
  })

  it('rejects uppercase, so a project key is never mistaken for a slug', () => {
    expect(SLUG_PATTERN.test('CAIRN-42')).toBe(false)
  })
})

describe('slug length', () => {
  const long = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ')

  it('never exceeds the cap', () => {
    expect(slugify(long(60)).length).toBeLessThanOrEqual(120)
  })

  it('cuts at a whole word rather than through one', () => {
    // Twelve entries in the store end mid-word — `...cannot-sha`,
    // `...dernier-passag` — which cannot be typed and read as corrupt.
    const slug = slugify(long(60))

    expect(slug.endsWith('-')).toBe(false)
    // Every segment is a word the title actually contained.
    for (const part of slug.split('-')) expect(part).toMatch(/^word\d+$/)
  })

  it('still produces something for a long title with no word breaks', () => {
    const slug = slugify('a'.repeat(300))

    expect(slug.length).toBe(120)
  })
})

describe('knowledge bodies (CAIRN-289)', () => {
  it('refuses a missing, empty or blank body on create', () => {
    expect(knowledgeCreate.safeParse({ title: 'A claim' }).success).toBe(false)
    expect(knowledgeCreate.safeParse({ title: 'A claim', body: '' }).success).toBe(false)
    expect(knowledgeCreate.safeParse({ title: 'A claim', body: ' \n\t ' }).success).toBe(false)
  })

  it('stores a real body exactly as written', () => {
    const parsed = knowledgeCreate.parse({ title: 'A claim', body: '  indented\n' })
    expect(parsed.body).toBe('  indented\n')
  })

  it('refuses an edit that blanks the body, and leaves an absent body alone', () => {
    expect(knowledgeUpdate.safeParse({ body: '' }).success).toBe(false)
    expect(knowledgeUpdate.parse({ title: 'renamed' })).toEqual({ title: 'renamed' })
  })
})
