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
vi.mock('./people', () => ({
  peopleByIds: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { id, email: `${id}@example.test`, name: id === 'julien' ? 'Julien' : id, active: true }])),
}))
const lab = vi.hoisted(() => ({ enabled: false }))
vi.mock('./lab-settings', () => ({ isLabEnabled: async () => lab.enabled }))
vi.mock('./subjects', () => ({
  labBrief: async () => ({
    stages: [{ id: 's1', name: 'exploring', category: 'active', color: '#6b7fa6', position: 1, count: 2 }],
    mine: [],
  }),
}))

import { buildContext, isLive, latestByActivity } from './context'

const actor = { userId: 'user', actorId: 'agent', actorType: 'agent', role: 'member', rateKey: 'agent', userDisplayName: 'Agent', sessionId: null } satisfies Actor
const task = (project: string, number: number, claimedAt: string) => ({
  id: `${project}-${number}`, number, project_id: project, project: { key: project }, title: `${project} work`,
  status: 'doing', claimed_by: 'agent', claimed_at: claimedAt, created_at: claimedAt,
  heartbeat_at: '2020-01-01T00:00:00Z', updated_at: claimedAt,
})
const session = (project: string, cwd: string, endedAt: string | null, updatedAt = endedAt ?? '2020-01-01T00:00:00Z') => ({
  project_id: project, project: { key: project }, cwd, ended_at: endedAt, updated_at: updatedAt,
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
      .toMatchObject({ filters: [['cwd', '/repo'], ['projects.key', 'MES']], limit: 20 })
  })

  /**
   * CAIRN-320: ordered by ended_at, an open session — no end yet — ranked
   * below every finished one, and the briefing showed an older session.
   */
  it('shows the open session over an older finished one, and says it is live', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString()
    db.sessions = [session('CAL', '/repo', '2020-01-01T00:00:00Z'), { ...session('MES', '/repo', null, recent) }]
    const context = await buildContext(actor, { cwd: '/repo' })
    expect(context.lastSession).toMatchObject({ request: 'MES request', ongoing: true, endedAt: null })
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

/**
 * Whose work is in the briefing (CAIRN-310).
 *
 * A task the caller's human owns and no agent is on surfaced only when
 * somebody thought to ask for it, and a dropped task in flight gave no hint
 * that it was somebody else's to finish.
 */
describe('context and the assignee', () => {
  const open = (
    number: number,
    over: Partial<{
      status: string
      priority: string
      assignee: string
      claimedBy: string
      heartbeat: string
      updated: string
      project: string
    }> = {},
  ) => {
    const project = over.project ?? 'MES'
    return {
      id: `${project}-${number}`, number, project_id: project, project: { key: project },
      title: `${project} task ${number}`, status: over.status ?? 'todo', priority: over.priority ?? 'medium',
      assignee_user_id: over.assignee ?? 'user', claimed_by: over.claimedBy ?? null,
      claimed_at: over.claimedBy ? '2020-01-01T00:00:00Z' : null, created_at: '2020-01-01T00:00:00Z',
      heartbeat_at: over.heartbeat ?? null, updated_at: over.updated ?? '2020-01-01T00:00:00Z',
    }
  }

  it('lists the callers own open work that nobody is on, most urgent first', async () => {
    const now = new Date().toISOString()
    db.tasks = [
      open(1, { priority: 'low', updated: '2020-01-05T00:00:00Z' }),
      open(2, { status: 'backlog', priority: 'urgent' }),
      open(3, { assignee: 'julien' }),
      open(4, { claimedBy: 'codex', heartbeat: now }),
      open(5, { claimedBy: 'codex', heartbeat: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z' }),
      open(6, { status: 'doing', updated: now }),
      open(7, { status: 'in-review' }),
      open(8, { project: 'CAL' }),
      open(9, { claimedBy: 'agent', heartbeat: '2020-01-01T00:00:00Z' }),
    ]
    const context = await buildContext(actor, { project: 'MES' })
    // 3 is Julien's, 4 has a live claim, 6 is already in flight, 7 is in
    // review, 8 is another project and 9 is held by the caller itself.
    expect(context.unattended.tasks.map((t) => t.ref)).toEqual(['MES-2', 'MES-5', 'MES-1'])
    expect(context.unattended.tasks[0]).toMatchObject({ status: 'backlog', priority: 'urgent' })
    expect(context.unattended.more).toBe(0)
  })

  it('names five and counts the rest', async () => {
    db.tasks = Array.from({ length: 8 }, (_, i) => open(i + 1, { updated: `2020-01-0${i + 1}T00:00:00Z` }))
    const context = await buildContext(actor, { project: 'MES' })
    // Most recently touched first, within a priority.
    expect(context.unattended.tasks.map((t) => t.ref)).toEqual(['MES-8', 'MES-7', 'MES-6', 'MES-5', 'MES-4'])
    expect(context.unattended.more).toBe(3)
  })

  it('says nothing about unattended work with no project to scope it to', async () => {
    db.tasks = [open(1)]
    const context = await buildContext(actor, {})
    expect(context.unattended).toEqual({ tasks: [], more: 0 })
  })

  it('names the owner of in-flight work only when it is someone elses', async () => {
    db.tasks = [open(1, { status: 'doing', assignee: 'julien' }), open(2, { status: 'doing' })]
    const context = await buildContext(actor, { project: 'MES' })
    const byRef = new Map(context.inFlight.map((t) => [t.ref, t]))
    expect(byRef.get('MES-1')?.assignee).toBe('Julien')
    expect(byRef.get('MES-2')).not.toHaveProperty('assignee')
  })
})

describe('the last session by activity', () => {
  const row = (ended_at: string | null, updated_at: string, request: string) =>
    ({ ended_at, updated_at, request, next_steps: null, agent_id: null })

  it('ranks a finished session by when it ended, even when it was re-posted later', () => {
    const retried = row('2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', 'retried summary')
    const newer = row('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 'newer')
    expect(latestByActivity([retried, newer]).map((s) => s.request)).toEqual(['newer', 'retried summary'])
  })

  it('calls an open session live only while it is being written to', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(isLive(row(null, '2026-01-01T11:30:00Z', 'x'), now)).toBe(true)
    expect(isLive(row(null, '2026-01-01T08:00:00Z', 'x'), now)).toBe(false)
    expect(isLive(row('2026-01-01T11:59:00Z', '2026-01-01T11:59:00Z', 'x'), now)).toBe(false)
  })
})

describe('the Lab in the briefing (docs/lab.md)', () => {
  it('has no lab field while the Lab is off', async () => {
    lab.enabled = false
    expect(await buildContext(actor, { project: 'MES' })).not.toHaveProperty('lab')
  })

  it('carries counts per stage and my subjects while it is on', async () => {
    lab.enabled = true
    const context = await buildContext(actor, { project: 'MES' })
    expect(context.lab?.stages).toEqual([expect.objectContaining({ name: 'exploring', count: 2 })])
    expect(context.lab?.mine).toEqual([])
    lab.enabled = false
  })
})
