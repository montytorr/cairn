import { describe, expect, it } from 'vitest'
import { matchesAssignees, parseAssignees, serializeAssignees, withAssignees } from './assignee-filter'

const ME = 'u-me'

describe('the assignee filter parameter', () => {
  it('defaults to the viewer when absent', () => {
    expect(parseAssignees(null, ME)).toEqual([ME])
    expect(parseAssignees(undefined, ME)).toEqual([ME])
  })

  it('means everyone for all, and with no viewer to default to', () => {
    expect(parseAssignees('all', ME)).toEqual([])
    expect(parseAssignees(null, '')).toEqual([])
  })

  it('resolves me for whoever opens the link, and drops repeats', () => {
    expect(parseAssignees('me,u2', ME)).toEqual([ME, 'u2'])
    expect(parseAssignees('u2,me,u2', 'u-other')).toEqual(['u2', 'u-other'])
  })

  it('keeps a plain link plain for the default, and writes all for everyone', () => {
    expect(serializeAssignees([ME], ME)).toBeNull()
    expect(serializeAssignees([], ME)).toBe('all')
    expect(serializeAssignees([ME, 'u2'], ME)).toBe('me,u2')
    expect(serializeAssignees(['u2'], ME)).toBe('u2')
  })

  it('round-trips every selection', () => {
    for (const selected of [[ME], [], ['u2'], [ME, 'u2']]) {
      expect(parseAssignees(serializeAssignees(selected, ME), ME)).toEqual(selected)
    }
  })

  it('keeps the rest of the query string when it rewrites the parameter', () => {
    expect(withAssignees('closed=1', [], ME)).toBe('closed=1&assignee=all')
    expect(withAssignees('closed=1&assignee=all', [ME], ME)).toBe('closed=1')
  })

  it('matches everyone when nobody is selected', () => {
    expect(matchesAssignees({ assignee_user_id: 'u2' }, [])).toBe(true)
    expect(matchesAssignees({ assignee_user_id: 'u2' }, [ME])).toBe(false)
    expect(matchesAssignees({ assignee_user_id: ME }, [ME])).toBe(true)
  })
})
