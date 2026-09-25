import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'

const db = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  sessions: [] as Record<string, unknown>[],
  calls: [] as { table: string; filters: [string, unknown][]; limit: number | null }[],
}))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = []
      let limit: number | null = null
      let order: { column: string; ascending: boolean } | null = null
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
        in: (column: string, value: unknown) => { filters.push([column, value]); return query },
        not: () => query,
        lt: () => query,
        order: (column: string, options?: { ascending?: boolean }) => {
          order = { column, ascending: options?.ascending !== false }
          return query
        },
        limit: (value: number) => { limit = value; return query },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows(), error: null })),
      }
      function rows(): Record<string, unknown>[] {
        db.calls.push({ table, filters: [...filters], limit })
        let result = (table === 'tasks' ? db.tasks : table === 'sessions' ? db.sessions : [])
          .filter((row) => filters.every(([column, value]) => {
            const actual = column === 'projects.key' ? (row.project as { key: string } | undefined)?.key : row[column]
            return Array.isArray(value) ? value.includes(actual) : actual === value
          }))
        if (order) {
          const { column, ascending } = order
          result = [...result].sort((a, b) =>
            String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1))
        }
        return limit === null ? result : result.slice(0, limit)
      }
      return query
    },
  }),
}))
vi.mock('./project-keys', () => ({
  liveProjectKey: async (key: string) => ({ key: key === 'OLD' ? 'MES' : key, renamed: null }),
  resolveProject: async (key: string) => key === 'TYPO' ? null : {
    project: { id: 'project-id', key: key === 'OLD' ? 'MES' : key },
    renamed: key === 'OLD' ? { key: 'OLD', to: 'MES', at: '2020-01-01T00:00:00Z', by: null } : null,
  },
  formerKeysByProject: async () => new Map(),
  formerRefsOf: () => [],
}))
vi.mock('./knowledge', () => ({ listKnowledge: async () => [] }))
vi.mock('./staleness', () => ({ stalenessFor: async () => new Map() }))

import { buildContext } from './context'

const actor = { userId: 'user', actorId: 'agent', actorType: 'agent', role: 'member', rateKey: 'agent', userDisplayName: 'Agent', sessionId: null } satisfies Actor
const task = (project: string, number: number, claimedAt: string) => ({
  id: `${project}-${number}`, number, project_id: project, project: { key: project }, title: `${project} work`,
  status: 'doing', claimed_by: 'agent', claimed_at: claimedAt, created_at: claimedAt,
  heartbeat_at: '2020-01-01T00:00:00Z', updated_at: claimedAt,
})
const session = (project: string, cwd: string, endedAt: string) => ({
  project_id: project, project: { key: project }, cwd, ended_at: endedAt,
  request: `${project} request`, next_steps: null, agent_id: 'agent',
})

beforeEach(() => { db.tasks = []; db.sessions = []; db.calls = [] })

describe('context project scope', () => {
  it('keeps the default cross-project held work and stale claims', async () => {
    db.tasks = [task('CAL', 1, '2020-01-01T00:00:00Z'), task('MES', 2, '2020-01-02T00:00:00Z')]
    const context = await buildContext(actor, { project: 'MES' })
    expect(context.held.map((item) => item.ref)).toEqual(['CAL-1', 'MES-2'])
    expect(context.staleClaims.map((item) => item.ref)).toEqual(['CAL-1', 'MES-2'])
  })

  it('filters held work before the limit, rather than hiding the only matching claim', async () => {
    db.tasks = [
      ...Array.from({ length: 10 }, (_, i) => task('CAL', i + 1, `2020-01-01T00:${String(i).padStart(2, '0')}:00Z`)),
      task('MES', 11, '2020-01-02T00:00:00Z'),
    ]
    const context = await buildContext(actor, { project: 'MES', scope: 'project' })
    expect(context.held.map((item) => item.ref)).toEqual(['MES-11'])
    expect(db.calls.find((call) => call.table === 'tasks' && call.filters.some(([key]) => key === 'claimed_by')))
      .toMatchObject({ filters: [['claimed_by', 'agent'], ['projects.key', 'MES']], limit: 10 })
  })

  it('filters the last session by project as well as cwd before selecting the latest', async () => {
    db.sessions = [session('MES', '/repo', '2020-01-01T00:00:00Z'), session('CAL', '/repo', '2020-01-02T00:00:00Z')]
    const context = await buildContext(actor, { project: 'MES', cwd: '/repo', scope: 'project' })
    expect(context.lastSession?.request).toBe('MES request')
    expect(db.calls.find((call) => call.table === 'sessions'))
      .toMatchObject({ filters: [['cwd', '/repo'], ['projects.key', 'MES']], limit: 1 })
  })

  it('filters stale claims before their limit', async () => {
    db.tasks = [
      ...Array.from({ length: 5 }, (_, i) => task('CAL', i + 1, `2020-01-01T00:${String(i).padStart(2, '0')}:00Z`)),
      task('MES', 6, '2020-01-02T00:00:00Z'),
    ]
    const context = await buildContext(actor, { project: 'MES', scope: 'project' })
    expect(context.staleClaims.map((item) => item.ref)).toEqual(['MES-6'])
    expect(db.calls.find((call) => call.table === 'tasks' && call.filters.some(([key]) => key === 'projects.key') && call.limit === 5))
      .toBeDefined()
  })

  it('uses the current project key when the caller supplies a retired key', async () => {
    db.tasks = [task('MES', 1, '2020-01-01T00:00:00Z'), task('CAL', 2, '2020-01-02T00:00:00Z')]
    db.sessions = [session('MES', '/mes', '2020-01-01T00:00:00Z'), session('CAL', '/cal', '2020-01-02T00:00:00Z')]
    const context = await buildContext(actor, { project: 'OLD', scope: 'project' })
    expect(context.project).toBe('MES')
    expect(context.projectRenamed).toMatchObject({ key: 'OLD', to: 'MES' })
    expect(context.held.map((item) => item.ref)).toEqual(['MES-1'])
    expect(context.lastSession?.request).toBe('MES request')
  })

  it('rejects an unresolved project rather than returning an unfiltered briefing', async () => {
    db.tasks = [task('CAL', 1, '2020-01-01T00:00:00Z')]
    await expect(buildContext(actor, { scope: 'project' })).rejects.toThrow('project scope requires a resolved project')
    expect(db.calls).toEqual([])
  })

  it('rejects an unknown explicit key instead of showing an empty project briefing', async () => {
    db.tasks = [task('MES', 1, '2020-01-01T00:00:00Z')]
    db.sessions = [session('MES', '/repo', '2020-01-02T00:00:00Z')]
    await expect(buildContext(actor, { scope: 'project', project: 'TYPO', cwd: '/repo' }))
      .rejects.toThrow('Project not found')
    expect(db.calls).toEqual([])
  })
})
