import { describe, expect, it } from 'vitest'
import {
  canDeleteSubject, handoffIsOpen, isConcluding, parseSubjectRef, safeColor, subjectHref, taskHref,
} from './types'

describe('parseSubjectRef', () => {
  it('reads LAB-12, lab-12 and 12 as the same subject', () => {
    expect(parseSubjectRef('LAB-12')).toBe(12)
    expect(parseSubjectRef('lab-12')).toBe(12)
    expect(parseSubjectRef('12')).toBe(12)
    expect(parseSubjectRef(' 12 ')).toBe(12)
  })

  it('refuses anything that is not a subject number', () => {
    for (const bad of ['', '0', 'LAB-0', 'LAB-', 'KDP-12', '12x', '-1', '1.5', 'S-12']) {
      expect(parseSubjectRef(bad), bad).toBeNull()
    }
  })
})

describe('hrefs', () => {
  it('addresses a subject at /lab/subjects/<n>', () => {
    expect(subjectHref(12)).toBe('/lab/subjects/12')
  })

  it('addresses a todo by its own project', () => {
    expect(taskHref('LT-41')).toBe('/projects/LT/tasks/41')
    expect(taskHref('MY-APP-7')).toBe('/projects/MY-APP/tasks/7')
    expect(taskHref('nonsense')).toBeNull()
    expect(taskHref('LT-x')).toBeNull()
  })
})

describe('isConcluding', () => {
  it('is true for the two stages that end a subject', () => {
    expect(isConcluding('completed')).toBe(true)
    expect(isConcluding('dropped')).toBe(true)
    expect(isConcluding('planned')).toBe(false)
    expect(isConcluding('active')).toBe(false)
  })
})

describe('handoffIsOpen', () => {
  const at = (status: string | null) => ({ status })

  it('is open until the tracker says it ended', () => {
    expect(handoffIsOpen(at(null))).toBe(true)
    expect(handoffIsOpen(at('doing'))).toBe(true)
  })

  it('is Cairn’s again once ended', () => {
    expect(handoffIsOpen(at('done'))).toBe(false)
    expect(handoffIsOpen(at('cancelled'))).toBe(false)
  })

  it('is not open when there is no hand-off', () => {
    expect(handoffIsOpen(null)).toBe(false)
    expect(handoffIsOpen(undefined)).toBe(false)
  })
})

describe('canDeleteSubject', () => {
  const owned = { owner: { id: 'u1', name: 'A' } }
  const unowned = { owner: null }

  it('lets the owner and an administrator, and nobody else', () => {
    expect(canDeleteSubject(owned, { userId: 'u1', role: 'member' })).toBe(true)
    expect(canDeleteSubject(owned, { userId: 'u2', role: 'member' })).toBe(false)
    expect(canDeleteSubject(owned, { userId: 'u2', role: 'admin' })).toBe(true)
    expect(canDeleteSubject(unowned, { userId: 'u1', role: 'member' })).toBe(false)
  })
})

describe('safeColor', () => {
  it('passes a hex colour and replaces anything else', () => {
    expect(safeColor('#8a8792')).toBe('#8a8792')
    expect(safeColor('red')).toBe('var(--fg-subtle)')
    expect(safeColor('url(javascript:x)')).toBe('var(--fg-subtle)')
    expect(safeColor(null, '#000000')).toBe('#000000')
  })
})
