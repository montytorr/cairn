import { describe, expect, it } from 'vitest'
import {
  formerRefsOf,
  keyChangeProblem,
  projectRedirectNotice,
  renameLine,
  renamesOf,
  taskMovedNotice,
  taskRedirectNotice,
} from './project-rename'

// The real case: A2A comms (AC) became Holloway (HOL) on 22 Sept 2026.
const RETIRED = '2026-09-22T08:00:00.000Z'
const renames = renamesOf([{ key: 'AC', retired_at: RETIRED }], 'HOL')
const before = { number: 113, created_at: '2026-09-01T10:00:00.000Z' }
const after = { number: 114, created_at: '2026-09-22T09:30:00.000Z' }

describe('renamesOf', () => {
  it('reads a chain of retired keys as successive renames', () => {
    expect(
      renamesOf(
        [
          { key: 'X', retired_at: '2026-09-20T00:00:00.000Z' },
          { key: 'AC', retired_at: '2026-09-10T00:00:00.000Z' },
        ],
        'HOL',
      ),
    ).toEqual([
      { from: 'AC', to: 'X', at: '2026-09-10T00:00:00.000Z' },
      { from: 'X', to: 'HOL', at: '2026-09-20T00:00:00.000Z' },
    ])
  })

  it('says what happened and when', () => {
    expect(renameLine({ from: 'AC', to: 'HOL', at: RETIRED })).toBe('project renamed AC → HOL on 22 Sept 2026')
  })
})

describe('formerRefsOf', () => {
  it('names the old ref of a task filed before the rename', () => {
    expect(formerRefsOf(renames, before).map((r) => r.ref)).toEqual(['AC-113'])
  })

  it('claims nothing for a task filed after the key was retired', () => {
    // HOL-114 was created once AC was gone; AC-114 never existed.
    expect(formerRefsOf(renames, after)).toEqual([])
  })

  it('keeps only the keys that were live when the task was filed', () => {
    const chain = renamesOf(
      [
        { key: 'AC', retired_at: '2026-09-10T00:00:00.000Z' },
        { key: 'X', retired_at: '2026-09-20T00:00:00.000Z' },
      ],
      'HOL',
    )
    const task = { number: 7, created_at: '2026-09-15T00:00:00.000Z' }
    expect(formerRefsOf(chain, task).map((r) => r.ref)).toEqual(['X-7'])
  })
})

describe('taskRedirectNotice', () => {
  it('says the old ref is now the new one', () => {
    expect(taskRedirectNotice('AC-113', renames, { ...before, ref: 'HOL-113' })).toBe(
      'AC-113 is now HOL-113 — project AC was renamed HOL on 22 Sept 2026.',
    )
  })

  it('does not pretend a ref issued after the rename ever existed', () => {
    const notice = taskRedirectNotice('AC-114', renames, { ...after, ref: 'HOL-114' })
    expect(notice).toMatch(/^AC-114 never existed/)
    expect(notice).toContain('before this task was filed')
  })

  it('ignores a marker that names no key this project retired', () => {
    expect(taskRedirectNotice('FOO-113', renames, { ...before, ref: 'HOL-113' })).toBeNull()
    expect(taskRedirectNotice('AC-9', renames, { ...before, ref: 'HOL-113' })).toBeNull()
    expect(taskRedirectNotice('<b>hi</b>', renames, { ...before, ref: 'HOL-113' })).toBeNull()
    expect(taskRedirectNotice(undefined, renames, { ...before, ref: 'HOL-113' })).toBeNull()
  })
})

describe('projectRedirectNotice', () => {
  it('says the old key is now the live one', () => {
    expect(projectRedirectNotice('ac', renames)).toBe(
      'AC is now HOL — the project was renamed on 22 Sept 2026. Old AC-n refs still lead to their tasks.',
    )
  })

  it('ignores a key this project never had', () => {
    expect(projectRedirectNotice('ZZ', renames)).toBeNull()
  })
})

describe('keyChangeProblem', () => {
  const context = {
    projectId: 'hol',
    current: 'HOL',
    liveKeys: ['CAIRN', 'HOLC'],
    retired: [
      { key: 'AC', project_id: 'hol', current: 'HOL' },
      { key: 'ACC', project_id: 'holc', current: 'HOLC' },
    ],
  }

  it('accepts a well-formed free key', () => {
    expect(keyChangeProblem('holl', context)).toBeNull()
  })

  it('applies the same rule as the API', () => {
    for (const bad of ['H', '1AB', 'HO-L', 'ABCDEFGHIJK', 'HÖL']) {
      expect(keyChangeProblem(bad, context)).toBe('Two to ten letters or digits, starting with a letter.')
    }
    expect(keyChangeProblem('  ', context)).toBe('Type the new key.')
  })

  it('refuses the current key and a live one', () => {
    expect(keyChangeProblem('HOL', context)).toMatch(/already this project's key/)
    expect(keyChangeProblem('CAIRN', context)).toMatch(/already the key of another project/)
  })

  it('refuses a key another project retired, and says why', () => {
    expect(keyChangeProblem('ACC', context)).toBe(
      'ACC used to be HOLC\'s key and can never be reused — every ACC-n ref still leads to HOLC.',
    )
  })

  it('lets a project take back its own former key', () => {
    expect(keyChangeProblem('AC', context)).toBeNull()
  })
})

describe('taskMovedNotice', () => {
  const moves = [{ ref: 'ABC-46', at: '2026-10-01T09:00:00.000Z' }]

  it('says where the task went when from is one of its former refs', () => {
    expect(taskMovedNotice('abc-46', moves, { ref: 'XYZ-8' })).toContain('ABC-46 is now XYZ-8')
  })

  it('does not believe a hand-edited from', () => {
    expect(taskMovedNotice('ABC-47', moves, { ref: 'XYZ-8' })).toBeNull()
    expect(taskMovedNotice(undefined, moves, { ref: 'XYZ-8' })).toBeNull()
  })
})
