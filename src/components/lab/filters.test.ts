import { describe, expect, it } from 'vitest'
import { NO_FILTERS, hasFilters, labQueryString, labUrl, parseLabFilters } from './filters'

describe('parseLabFilters', () => {
  it('reads comma lists, trimmed and de-duplicated', () => {
    const f = parseLabFilters({ stage: 'exploring, done,exploring', tag: 'search', project: 'CAIRN,none' })
    expect(f.stage).toEqual(['exploring', 'done'])
    expect(f.tag).toEqual(['search'])
    expect(f.project).toEqual(['CAIRN', 'none'])
  })

  it('keeps only real categories', () => {
    expect(parseLabFilters({ category: 'planned,bogus,dropped' }).category).toEqual(['planned', 'dropped'])
  })

  it('takes the first of a repeated parameter', () => {
    expect(parseLabFilters({ q: ['one', 'two'] }).q).toBe('one')
  })

  it('shows archived only when asked to include them', () => {
    expect(parseLabFilters({ archived: 'include' }).archived).toBe(true)
    expect(parseLabFilters({ archived: 'only' }).archived).toBe(false)
    expect(parseLabFilters({}).archived).toBe(false)
  })

  it('reads URLSearchParams too', () => {
    expect(parseLabFilters(new URLSearchParams('owner=me&q=pg')).owner).toBe('me')
  })
})

describe('labQueryString and labUrl', () => {
  it('is empty for no filters, so the Lab is just /lab', () => {
    expect(labQueryString(NO_FILTERS)).toBe('')
    expect(labUrl(NO_FILTERS)).toBe('/lab')
    expect(hasFilters(NO_FILTERS)).toBe(false)
  })

  it('round-trips a filtered Lab through its own URL', () => {
    const filters = {
      ...NO_FILTERS,
      stage: ['exploring'],
      category: ['planned' as const],
      tag: ['search', 'ai'],
      owner: 'me',
      project: ['none'],
      q: 'vector',
      archived: true,
    }
    const url = labUrl(filters)
    expect(url.startsWith('/lab?')).toBe(true)
    expect(parseLabFilters(new URLSearchParams(url.slice('/lab?'.length)))).toEqual(filters)
    expect(hasFilters(filters)).toBe(true)
  })

  it('leaves a blank search out', () => {
    expect(labQueryString({ ...NO_FILTERS, q: '   ' })).toBe('')
  })
})
