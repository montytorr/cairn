import { describe, expect, it } from 'vitest'
import {
  createTaskSchema,
  updateTaskSchema,
  isTerminal,
  parseTaskRef,
  TASK_STATUSES,
} from './task'

describe('createTaskSchema', () => {
  it('applies defaults when fields are omitted', () => {
    expect(createTaskSchema.parse({ title: 'x' })).toEqual({
      title: 'x',
      type: 'feature',
      status: 'backlog',
      priority: 'medium',
      labels: [],
    })
  })

  it('keeps explicit values', () => {
    const parsed = createTaskSchema.parse({ title: 'x', type: 'chore', priority: 'high' })
    expect(parsed.type).toBe('chore')
    expect(parsed.priority).toBe('high')
  })
})

describe('createTaskSchema: bug and spike bodies (CAIRN-291)', () => {
  const report = 'Clicking save drops the draft; expected it to persist. Repro: edit, save, reload.'

  it.each(['bug', 'spike'])('refuses a %s with no body, on the description field', (type) => {
    const parsed = createTaskSchema.safeParse({ title: 'x', type })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toEqual(['description'])
    expect(parsed.error?.issues[0]?.message).toContain('forceEmpty')
  })

  it('refuses a body that only restates the title', () => {
    expect(createTaskSchema.safeParse({ title: 'x', type: 'bug', description: '   see title   ' }).success).toBe(false)
  })

  it('accepts a real body, and the explicit escape hatch', () => {
    expect(createTaskSchema.safeParse({ title: 'x', type: 'bug', description: report }).success).toBe(true)
    expect(createTaskSchema.safeParse({ title: 'x', type: 'spike', forceEmpty: true }).success).toBe(true)
  })

  it('leaves the other types alone', () => {
    for (const type of ['feature', 'chore', 'improvement', 'docs']) {
      expect(createTaskSchema.safeParse({ title: 'x', type }).success).toBe(true)
    }
  })
})

describe('updateTaskSchema', () => {
  /**
   * Regression guard for a real data-corruption bug.
   *
   * updateTaskSchema used to be createTaskSchema.partial(), but `.default()`
   * survives `.partial()` — Zod wraps the ZodDefault in a ZodOptional rather
   * than replacing it. The result was that every PATCH carried type: 'feature'
   * and priority: 'medium', silently resetting fields the caller never
   * mentioned. Two tasks were closed as `bug` and came back as `feature`
   * before this was caught.
   */
  it('does NOT inject defaults for omitted fields', () => {
    const parsed = updateTaskSchema.parse({ status: 'done' })
    expect(parsed).toEqual({ status: 'done' })
    expect(parsed).not.toHaveProperty('type')
    expect(parsed).not.toHaveProperty('priority')
    expect(parsed).not.toHaveProperty('labels')
  })

  it('is empty for an empty patch', () => {
    expect(updateTaskSchema.parse({})).toEqual({})
  })

  it('still validates the fields it is given', () => {
    expect(updateTaskSchema.safeParse({ status: 'in-progress' }).success).toBe(false)
    expect(updateTaskSchema.safeParse({ type: 'nonsense' }).success).toBe(false)
  })

  /**
   * `dueDate` is the one field on `taskFields` that a caller needs to be able
   * to unset outright — the create schema has no such need, so this is only
   * widened on the update schema rather than on the shared base.
   */
  it('accepts null on dueDate to clear it, but not other date-shaped junk', () => {
    expect(updateTaskSchema.parse({ dueDate: null })).toEqual({ dueDate: null })
    expect(updateTaskSchema.parse({ dueDate: '2026-01-15' })).toEqual({ dueDate: '2026-01-15' })
    expect(updateTaskSchema.safeParse({ dueDate: 'not-a-date' }).success).toBe(false)
  })
})

describe('isTerminal', () => {
  it('gates exactly the statuses that require a resolution', () => {
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('doing')).toBe(false)
    expect(isTerminal('in-review')).toBe(false)
  })
})

describe('parseTaskRef', () => {
  it('splits a project key from the task number', () => {
    expect(parseTaskRef('CAI-42')).toEqual({ key: 'CAI', number: 42 })
  })

  it('rejects malformed refs', () => {
    expect(() => parseTaskRef('42')).toThrow()
    expect(() => parseTaskRef('cai-42')).toThrow()
  })
})

describe('terminal transitions release the claim', () => {
  /**
   * Guard for a bug found by reading the board: three finished tasks still
   * showed "held by claude-code" because the PATCH route never cleared the
   * claim. The claim exists to answer "is another agent on this?", so a stale
   * one on finished work makes the field untrustworthy.
   *
   * The route consults isTerminal() to decide, so this pins that contract.
   */
  it('treats exactly done and cancelled as releasing', () => {
    const releases = TASK_STATUSES.filter((s) => isTerminal(s))
    expect(releases).toEqual(['done', 'cancelled'])
  })

  it('does not release on an in-flight status', () => {
    for (const s of ['backlog', 'todo', 'doing', 'in-review'] as const) {
      expect(isTerminal(s)).toBe(false)
    }
  })
})

describe('external refs', () => {
  it('accepts a ref and an http(s) url on create, and neither', () => {
    expect(createTaskSchema.parse({ title: 'x', externalRef: 'tracker:host/T-4', externalUrl: 'https://example.test/t/4' })).toMatchObject({
      externalRef: 'tracker:host/T-4',
      externalUrl: 'https://example.test/t/4',
    })
    const bare = createTaskSchema.parse({ title: 'x' })
    expect(bare).not.toHaveProperty('externalRef')
    expect(bare).not.toHaveProperty('externalUrl')
  })

  it('refuses whitespace, control characters, an empty ref and one over 200', () => {
    for (const externalRef of ['has space', 'tab\there', 'line\nbreak', 'nul\u0000', '', 'x'.repeat(201)]) {
      expect(createTaskSchema.safeParse({ title: 'x', externalRef }).success, JSON.stringify(externalRef)).toBe(false)
    }
    expect(createTaskSchema.safeParse({ title: 'x', externalRef: 'x'.repeat(200) }).success).toBe(true)
  })

  it('refuses a url that is not http(s) or runs past 2000 characters', () => {
    for (const externalUrl of ['javascript:alert(1)', 'ftp://example.test/a', 'not a url', `https://example.test/${'a'.repeat(2_000)}`]) {
      expect(createTaskSchema.safeParse({ title: 'x', externalUrl }).success, externalUrl).toBe(false)
    }
  })

  it('lets an update clear both with null, and leaves them absent otherwise', () => {
    expect(updateTaskSchema.parse({ externalRef: null, externalUrl: null })).toEqual({ externalRef: null, externalUrl: null })
    expect(updateTaskSchema.parse({ title: 'y' })).toEqual({ title: 'y' })
    expect(updateTaskSchema.safeParse({ externalRef: 'has space' }).success).toBe(false)
  })
})
