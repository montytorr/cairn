import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lookupMovedRef } from './task-moves'
import { renameFields } from './tasks'

const MOVED = '2026-10-01T09:00:00.000Z'
const RETIRED = '2026-09-22T07:58:11.000Z'

type Tables = {
  projects: Record<string, unknown>[]
  project_former_keys: Record<string, unknown>[]
  task_former_refs: Record<string, unknown>[]
}
const scope = globalThis as typeof globalThis & { __cairnPool?: unknown }
let prior: unknown

// The one query lookupMovedRef sends, answered from the tables: the key names
// a project by its live key or a retired one, then the alias by number.
const install = (tables: Tables) => {
  scope.__cairnPool = {
    query: async (_sql: string, [key, number]: [string, number]) => {
      const projects = new Set([
        ...tables.projects.filter((row) => row.key === key).map((row) => row.id),
        ...tables.project_former_keys.filter((row) => row.key === key).map((row) => row.project_id),
      ])
      const rows = tables.task_former_refs.filter((row) => projects.has(row.project_id) && row.number === number)
      return { rows, rowCount: rows.length }
    },
  }
}

beforeEach(() => {
  prior = scope.__cairnPool
})
afterEach(() => {
  scope.__cairnPool = prior
})

const TABLES: Tables = {
  projects: [
    { id: 'id-abc', key: 'ABC', title: 'Source' },
    { id: 'id-xyz', key: 'XYZ', title: 'Target' },
    { id: 'id-new', key: 'NEW', title: 'Renamed' },
  ],
  project_former_keys: [{ key: 'OLD', project_id: 'id-new', retired_at: RETIRED, retired_by: null }],
  task_former_refs: [
    { project_id: 'id-abc', number: 46, task_id: 'task-1', moved_at: MOVED },
    { project_id: 'id-new', number: 3, task_id: 'task-2', moved_at: MOVED },
  ],
}

describe('resolving a ref a task moved away from', () => {
  it('finds the task by the project and number it left', async () => {
    install(TABLES)
    expect(await lookupMovedRef('abc', 46)).toEqual({
      taskId: 'task-1',
      move: { ref: 'ABC-46', at: MOVED },
    })
  })

  it('still finds it when the source project was renamed afterwards', async () => {
    install(TABLES)
    expect(await lookupMovedRef('OLD', 3)).toMatchObject({ taskId: 'task-2', move: { ref: 'OLD-3' } })
    expect(await lookupMovedRef('NEW', 3)).toMatchObject({ taskId: 'task-2' })
  })

  it('is nothing for a number that never moved or a key nobody had', async () => {
    install(TABLES)
    expect(await lookupMovedRef('ABC', 47)).toBeNull()
    expect(await lookupMovedRef('NOPE', 46)).toBeNull()
  })
})

describe('what a response says about a moved ref', () => {
  const moved = { ref: 'ABC-46', to: 'XYZ-8', at: MOVED }

  it('adds requested_ref and moved_from only when a former ref was used', () => {
    expect(renameFields({ renamed: null, requestedRef: 'XYZ-8' })).toEqual({})
    expect(renameFields({ renamed: null, moved, requestedRef: 'ABC-46' })).toEqual({
      requested_ref: 'ABC-46',
      moved_from: moved,
    })
  })
})
