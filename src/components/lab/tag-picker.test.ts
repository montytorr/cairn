import { describe, expect, it } from 'vitest'
import { filterTags, tagToCreate } from './tag-picker'

const tags = [{ name: 'search' }, { name: 'ai' }, { name: 'infra' }]

describe('filterTags', () => {
  it('narrows by a substring, any case, and passes everything for an empty query', () => {
    expect(filterTags(tags, 'IN').map((t) => t.name)).toEqual(['infra'])
    expect(filterTags(tags, '  ').length).toBe(3)
  })
})

describe('tagToCreate', () => {
  it('offers the typed name, lower-cased', () => {
    expect(tagToCreate(tags, '  Vector ')).toBe('vector')
  })

  it('offers nothing for an empty name, an existing one or an over-long one', () => {
    expect(tagToCreate(tags, '')).toBeNull()
    expect(tagToCreate(tags, 'AI')).toBeNull()
    expect(tagToCreate(tags, 'x'.repeat(41))).toBeNull()
  })
})
