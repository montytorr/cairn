import { describe, expect, it } from 'vitest'
import { taskLabFields } from './task-fields'

describe('taskLabFields', () => {
  it('leaves subject absent when the server omitted it (the Lab is off)', () => {
    const fields = taskLabFields({ id: 't1' })
    expect('subject' in fields).toBe(false)
    expect(fields.handoff).toBeNull()
  })

  it('keeps a null subject: the Lab is on and the task is unlinked', () => {
    expect(taskLabFields({ subject: null }).subject).toBeNull()
  })

  it('carries the subject and the hand-off', () => {
    const handoff = { tracker: 'github', ref: 'a/b#4', url: null, status: 'open', synced_at: null }
    const fields = taskLabFields({ subject: { ref: 'LAB-3', title: 'x' }, handoff })
    expect(fields.subject).toEqual({ ref: 'LAB-3', title: 'x' })
    expect(fields.handoff).toEqual(handoff)
  })

  it('survives nothing at all', () => {
    expect(taskLabFields(null)).toEqual({ handoff: null })
  })
})
