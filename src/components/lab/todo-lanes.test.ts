import { describe, expect, it } from 'vitest'
import { asStatus, boardLanes, listGroups, needsResolution, statusLocked, tally } from './todo-lanes'

const todo = (status: string, handoff: { status: string | null } | null = null) => ({
  status,
  handoff: handoff && { tracker: 'cairn', ref: 'KDP-1', url: null, synced_at: null, ...handoff },
})

describe('boardLanes', () => {
  it('always has todo, doing, in review and done', () => {
    expect(boardLanes([], false)).toEqual(['todo', 'doing', 'in-review', 'done'])
  })

  it('adds backlog only when something is in it, and cancelled only when asked', () => {
    expect(boardLanes([todo('backlog')], false)).toContain('backlog')
    expect(boardLanes([todo('cancelled')], false)).not.toContain('cancelled')
    expect(boardLanes([todo('cancelled')], true)).toContain('cancelled')
  })
})

describe('listGroups', () => {
  it('puts work in hand first and leaves empty groups out', () => {
    const groups = listGroups([todo('done'), todo('doing'), todo('todo')], false)
    expect(groups.map((g) => g.status)).toEqual(['doing', 'todo', 'done'])
  })

  it('hides cancelled unless shown', () => {
    expect(listGroups([todo('cancelled')], false)).toEqual([])
    expect(listGroups([todo('cancelled')], true)).toHaveLength(1)
  })

  it('files an unknown status under todo rather than dropping the row', () => {
    expect(asStatus('triage')).toBe('todo')
    expect(listGroups([todo('triage')], false)[0]?.status).toBe('todo')
  })
})

describe('needsResolution', () => {
  it('asks when a todo is closed, not when it moves between the closed states', () => {
    expect(needsResolution('doing', 'done')).toBe(true)
    expect(needsResolution('doing', 'cancelled')).toBe(true)
    expect(needsResolution('done', 'cancelled')).toBe(false)
    expect(needsResolution('done', 'doing')).toBe(false)
  })
})

describe('statusLocked', () => {
  it('locks a todo whose hand-off is open, and frees it once ended', () => {
    expect(statusLocked(todo('todo'))).toBe(false)
    expect(statusLocked(todo('todo', { status: null }))).toBe(true)
    expect(statusLocked(todo('todo', { status: 'doing' }))).toBe(true)
    expect(statusLocked(todo('done', { status: 'done' }))).toBe(false)
  })
})

describe('tally', () => {
  it('counts what is open, done and cancelled', () => {
    expect(tally([todo('todo'), todo('doing'), todo('done'), todo('cancelled')])).toEqual({
      open: 2,
      done: 1,
      cancelled: 1,
    })
  })
})
