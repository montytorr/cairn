import { describe, expect, it } from 'vitest'
import { SUBJECT_TABS, isSubjectTab } from './subject-tabs'

describe('isSubjectTab', () => {
  it('accepts each section and nothing else', () => {
    for (const tab of SUBJECT_TABS) expect(isSubjectTab(tab)).toBe(true)
    expect(isSubjectTab('nope')).toBe(false)
    expect(isSubjectTab(undefined)).toBe(false)
  })
})
