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
    const parsed = createTaskSchema.parse({ title: 'x', type: 'bug', priority: 'high' })
    expect(parsed.type).toBe('bug')
    expect(parsed.priority).toBe('high')
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
