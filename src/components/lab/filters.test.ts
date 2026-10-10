import { describe, expect, it } from 'vitest'
import { NO_FILTERS, hasFilters, labQueryString, labUrl, parseLabFilters, toSubjectQuery } from './filters'

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

describe('toSubjectQuery', () => {
  const me = '11111111-1111-4111-8111-111111111111'

  it('hands the library comma lists, and leaves out what is not set', () => {
    expect(toSubjectQuery(me, { ...NO_FILTERS, stage: ['a', 'b'], tag: ['x'], q: 'pg' })).toEqual({
      stage: 'a,b',
      tag: 'x',
      q: 'pg',
      archived: 'exclude',
    })
  })

  it('turns `me` into the viewer and keeps a user id', () => {
    expect(toSubjectQuery(me, { ...NO_FILTERS, owner: 'me' }).ownerId).toBe(me)
    const other = '22222222-2222-4222-8222-222222222222'
    expect(toSubjectQuery(me, { ...NO_FILTERS, owner: other }).ownerId).toBe(other)
  })

  it('drops an owner that is neither, rather than sending a cast that would fail', () => {
    expect(toSubjectQuery(me, { ...NO_FILTERS, owner: "bob'; --" }).ownerId).toBeUndefined()
  })

  it('includes archived only when asked', () => {
    expect(toSubjectQuery(me, { ...NO_FILTERS, archived: true }).archived).toBe('include')
  })
})
