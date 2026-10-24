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
const scope = globalThis as typeof globalThis & { __cairnPool?: unknown; __cairnJsonColumns?: unknown }
let prior: { pool: unknown; json: unknown }
let statements: { sql: string; values: unknown[] }[] = []

const install = (tables: Tables) => {
  statements = []
  scope.__cairnJsonColumns = Promise.resolve(new Set<string>())
  scope.__cairnPool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values })
        if (/from "task_former_refs"/.test(sql)) {
          const rows = tables.task_former_refs.filter(
            (row) => row.project_id === values[0] && row.number === values[1],
          )
          return { rows, rowCount: rows.length }
        }
        const table = /from "project_former_keys"/.test(sql) ? 'project_former_keys' : 'projects'
        const rows = tables[table].filter((row) => {
          if (/\."key" = \$1/.test(sql)) return row.key === values[0]
          if (/\."id" = \$1/.test(sql)) return row.id === values[0]
          return true
        })
        return { rows, rowCount: rows.length }
      },
      release: () => {},
    }),
  }
}

beforeEach(() => {
  prior = { pool: scope.__cairnPool, json: scope.__cairnJsonColumns }
})
afterEach(() => {
  scope.__cairnPool = prior.pool
  scope.__cairnJsonColumns = prior.json
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
