import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Another tracker's ref finds the task that is that issue (CAIRN-413).
 *
 * `DIS-2237` on an instance whose project is DISPOF named no project, so the
 * ref lookup gave up silently and full-text ranked the imported task 9th of
 * 11. It now falls back to the trailing ref of `external_ref` and pins every
 * holder first, the way a native ref is pinned (CAIRN-132).
 *
 * The trailing-ref expression itself runs in Postgres, so here the index probe
 * is a stub that answers with ids; the SQL is covered against a real database
 * in tests/integration/search-external-ref.test.ts.
 */

type FakeTask = {
  id: string
  number: number
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  external_ref: string | null
  updated_at: string
  project: { key: string }
}

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  query: vi.fn(),
  tasks: [] as FakeTask[],
}))

const matches = (task: FakeTask, [column, op, value]: [string, string, unknown]) => {
  if (column === 'projects.key') return task.project.key === value
  if (op === 'in') return (value as unknown[]).includes(task[column as keyof FakeTask])
  return task[column as keyof FakeTask] === value
}

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
  admin: () => ({
    rpc: mocks.rpc,
    from: () => {
      const filters: [string, string, unknown][] = []
      let ordered = false
      const found = () => {
        const rows = mocks.tasks.filter((task) => filters.every((filter) => matches(task, filter)))
        return ordered ? [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : rows
      }
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, '=', value]); return query },
        in: (column: string, value: unknown[]) => { filters.push([column, 'in', value]); return query },
        order: () => { ordered = true; return query },
        limit: () => query,
        maybeSingle: async () => ({ data: found()[0] ?? null, error: null }),
        then: (resolve: (result: { data: FakeTask[] }) => unknown) => Promise.resolve(resolve({ data: found() })),
      }
      return query
    },
  }),
}))

vi.mock('./project-keys', () => ({
  lookupFormerKey: async () => null,
  issuedUnderFormerKey: () => true,
}))

vi.mock('./task-moves', () => ({ lookupMovedRef: async () => null }))

vi.mock('./lab-settings', () => ({ isLabEnabled: async () => false }))

import { searchAll, searchTasks } from './search'

const task = (key: string, number: number, extra: Partial<FakeTask> = {}): FakeTask => ({
  id: `${key}-${number}-id`,
  number,
  title: `task ${key}-${number}`,
  description: null,
  type: 'bug',
  status: 'todo',
  priority: 'medium',
  resolution: null,
  resolution_kind: null,
  claimed_by: null,
  external_ref: null,
  updated_at: '2026-10-01T00:00:00.000Z',
  project: { key },
  ...extra,
})

const imported = task('DISPOF', 231, { external_ref: 'linear.app/DIS-9001', type: 'improvement', status: 'doing' })

/** What the index probe returns: the ids whose trailing ref is the query's. */
const holders = (...tasks: FakeTask[]) =>
  mocks.query.mockResolvedValue({ rows: tasks.map(({ id }) => ({ id })) })

const rankedTask = (t: FakeTask, rank: number) => ({
  ...t, project: undefined, project_key: t.project.key, rank, coverage: 1, widened: false,
})

const rankedAll = (kind: string, id: string, ref: string, rank: number) => ({
  kind, id, ref, title: ref, subtitle: null, project_key: null, status: null, type: null,
  answered: false, updated_at: '2026-10-01T00:00:00.000Z', body_bytes: 10, rank, widened: false,
})

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.query.mockReset()
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.tasks = [imported, task('DISPOF', 119), task('DISPOF', 232)]
})

describe('a ref whose key is no project here', () => {
  it('pins the external_ref holder first on the unified path, and only once', async () => {
    holders(imported)
    mocks.rpc.mockResolvedValue({
      data: [
        rankedAll('knowledge', 'k-1', 'dis-9001-notes', 0.9),
        rankedAll('task', 'DISPOF-232-id', 'DISPOF-232', 0.5),
        rankedAll('task', imported.id, 'DISPOF-231', 0.1),
      ],
      error: null,
    })

    const { rows } = await searchAll('user-1', 'DIS-9001', {}, 20)

    expect(rows.map((r) => r.ref)).toEqual(['DISPOF-231', 'dis-9001-notes', 'DISPOF-232'])
    expect(rows[0]).toMatchObject({ kind: 'task', rank: Number.POSITIVE_INFINITY })
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("regexp_replace(external_ref, '^.*[/:]', '')"), ['DIS-9001', 5])
  })

  it('pins it first on the task path, and only once', async () => {
    holders(imported)
    mocks.rpc.mockResolvedValue({
      data: [rankedTask(task('DISPOF', 232), 0.5), rankedTask(imported, 0.1)],
      error: null,
    })

    const { rows } = await searchTasks('user-1', 'DIS-9001', {}, 20)

    expect(rows.map((r) => `${r.project_key}-${r.number}`)).toEqual(['DISPOF-231', 'DISPOF-232'])
    expect(rows[0]).toMatchObject({ external_ref: 'linear.app/DIS-9001', rank: Number.POSITIVE_INFINITY })
  })

  it('upper-cases the ref a human types before probing', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    await searchTasks('user-1', '  dis-9001 ', {}, 20)

    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), ['DIS-9001', 5])
  })

  it('pins every holder of a shared tail, newest first, rather than picking one', async () => {
    const older = task('HOL', 1, { external_ref: 'croft:croft.montytorr.com/T-1', updated_at: '2026-09-01T00:00:00.000Z' })
    const newer = task('DROVE', 7, { external_ref: 'linear.app/T-1', updated_at: '2026-10-10T00:00:00.000Z' })
    mocks.tasks.push(older, newer)
    holders(newer, older)
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    const { rows } = await searchAll('user-1', 'T-1', {}, 20)

    expect(rows.map((r) => r.ref)).toEqual(['DROVE-7', 'HOL-1'])
  })
})

describe('a one-letter key with no external_ref holder', () => {
  it('is answered by full-text alone, not an error', async () => {
    const mention = task('DISPOF', 232)
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'search_all'
        ? [rankedAll('task', mention.id, 'DISPOF-232', 0.5)]
        : [rankedTask(mention, 0.5)],
      error: null,
    }))

    const all = await searchAll('user-1', 'T-404', {}, 20)
    const tasks = await searchTasks('user-1', 'T-404', {}, 20)

    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), ['T-404', 5])
    expect(all.rows.map((r) => r.ref)).toEqual(['DISPOF-232'])
    expect(all.rows[0]?.rank).toBe(0.5)
    expect(tasks.rows.map((r) => r.id)).toEqual([mention.id])
  })
})

describe('a native ref', () => {
  it('wins over an external_ref with the same tail, which is never probed', async () => {
    const native = task('CAIRN', 5)
    const foreign = task('DISPOF', 40, { external_ref: 'cairn.app.dispofi.fr/CAIRN-5' })
    mocks.tasks.push(native, foreign)
    holders(foreign)
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    const all = await searchAll('user-1', 'CAIRN-5', {}, 20)
    const tasks = await searchTasks('user-1', 'CAIRN-5', {}, 20)

    expect(all.rows.map((r) => r.ref)).toEqual(['CAIRN-5'])
    expect(tasks.rows.map((r) => r.id)).toEqual([native.id])
    expect(mocks.query).not.toHaveBeenCalled()
  })
})

describe('a filter the caller set', () => {
  beforeEach(() => {
    holders(imported)
    mocks.rpc.mockResolvedValue({ data: [], error: null })
  })

  it.each([
    ['project', { project: 'HOL' }],
    ['type', { type: 'bug' }],
    ['status', { status: 'done' }],
  ])('drops the pinned row on the task path when its %s does not match', async (_name, filters) => {
    const { rows } = await searchTasks('user-1', 'DIS-9001', filters, 20)
    expect(rows).toEqual([])
  })

  it('keeps it on the task path when the filters match', async () => {
    const { rows } = await searchTasks('user-1', 'DIS-9001', { project: 'dispof', type: 'improvement', status: 'doing' }, 20)
    expect(rows.map((r) => r.id)).toEqual([imported.id])
  })

  it('drops it on the unified path when it is in another project', async () => {
    const { rows } = await searchAll('user-1', 'DIS-9001', { project: 'HOL' }, 20)
    expect(rows).toEqual([])
  })

  it('keeps it on the unified path when it is in that project, in any case', async () => {
    const { rows } = await searchAll('user-1', 'DIS-9001', { project: 'dispof' }, 20)
    expect(rows.map((r) => r.ref)).toEqual(['DISPOF-231'])
  })

  it('drops it on the unified path when tasks are not asked for', async () => {
    const { rows } = await searchAll('user-1', 'DIS-9001', { kinds: ['knowledge'] }, 20)
    expect(rows).toEqual([])
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
