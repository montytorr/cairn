import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'
import { untouchedCheckpoint, workedCheckpoint } from './sessions'

const db = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  filters: [] as string[],
  rpcs: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: (table: string) => {
      let events: string[] = []
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          db.filters.push(`${table}.${column}=${String(value)}`)
          return query
        },
        not: (column: string, operator: string, value: unknown) => {
          db.filters.push(`${table}.${column} not ${operator} ${String(value)}`)
          return query
        },
        in: (column: string, values: unknown[]) => {
          if (column === 'event') events = values as string[]
          return query
        },
        gte: () => query,
        order: () => query,
        then: (resolve: (result: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve(
            resolve({
              data:
                table === 'tasks'
                  ? db.tasks
                  : table === 'task_activity_events'
                    ? db.events
                        .filter((e) => events.includes(e.event as string))
                        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                    : [],
              error: null,
            }),
          ),
      }
      return query
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      db.rpcs.push(args)
      return { data: true, error: null }
    },
  }),
}))

import {
  CLAIM_EVIDENCE_EVENTS,
  lastSignOfLife,
  reconcileClaims,
  reconcilesWorkspace,
  releaseNote,
} from './reconcile'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

const claim = (number: number, holder: string, overrides: Record<string, unknown> = {}) => ({
  id: `task-${number}`,
  number,
  status: 'doing',
  claimed_by: holder,
  claimed_at: hoursAgo(168),
  heartbeat_at: hoursAgo(168),
  checkpoint_at: null,
  updated_at: hoursAgo(168),
  checkpoint_summary: null,
  ownership_version: 3,
  project: { key: 'BB' },
  ...overrides,
})

const agent = (agentName: string, actorId = `${agentName} · Monty`): Actor => ({
  userId: 'user-1',
  actorType: 'agent',
  actorId,
  userDisplayName: 'Monty',
  role: 'member',
  rateKey: 'key:1',
  sessionId: null,
  agentName,
})

beforeEach(() => {
  db.tasks = []
  db.events = []
  db.filters = []
  db.rpcs = []
})

describe('who reconcile covers', () => {
  it('lets the maintenance key sweep the whole workspace', () => {
    expect(reconcilesWorkspace(agent('maintenance'))).toBe(true)
  })

  it('does not grant it by display name: actorId embeds a name any user can edit', () => {
    expect(reconcilesWorkspace(agent('claude-code', 'maintenance · Monty'))).toBe(false)
    expect(reconcilesWorkspace({ actorType: 'agent', agentName: undefined })).toBe(false)
    expect(reconcilesWorkspace({ actorType: 'human', agentName: 'maintenance' })).toBe(false)
  })

  // The scheduled job ran as maintenance, which holds nothing, and so it
  // logged `#0` every 30 minutes from 2026-09-12 onwards (CAIRN-284).
  it('releases other agents’ quiet claims when run as maintenance', async () => {
    db.tasks = [claim(385, 'claude-code · Monty'), claim(405, 'openclaw · Monty', { status: 'in-review' })]
    const result = await reconcileClaims(agent('maintenance'))

    expect(db.filters).toContain('tasks.claimed_by not is null')
    expect(result.scope).toBe('workspace')
    expect(result.released.map((r) => [r.ref, r.holder, r.reopened])).toEqual([
      ['BB-385', 'claude-code · Monty', true],
      ['BB-405', 'openclaw · Monty', false],
    ])
    // The swap is guarded by the holder the snapshot saw, not by the caller.
    expect(db.rpcs.map((a) => a.p_expected_holder)).toEqual(['claude-code · Monty', 'openclaw · Monty'])
    expect(db.rpcs.map((a) => a.p_actor_id)).toEqual(['maintenance · Monty', 'maintenance · Monty'])
  })

  it('keeps an ordinary agent to its own claims', async () => {
    db.tasks = [claim(1, 'codex · Monty')]
    const result = await reconcileClaims(agent('codex'))

    expect(db.filters).toContain('tasks.claimed_by=codex · Monty')
    expect(result.scope).toBe('own')
  })

  it('releases nothing on a dry run', async () => {
    db.tasks = [claim(1, 'claude-code · Monty')]
    const result = await reconcileClaims(agent('maintenance'), { dryRun: true })

    expect(result.released).toHaveLength(1)
    expect(db.rpcs).toEqual([])
  })
})

describe('what counts as a sign of life', () => {
  // One timestamp, not three: separate hoursAgo() calls can land a millisecond
  // apart, and the test then compares against whichever was latest.
  const weekAgo = hoursAgo(168)
  const quiet = {
    heartbeat_at: weekAgo,
    claimed_at: weekAgo,
    updated_at: weekAgo,
    checkpoint_at: hoursAgo(0.1),
  }

  // OD-101, HOL-122 and CAIRN-273 were checkpointed "still held" by a
  // session sweep every 30 minutes and could never go quiet (CAIRN-283).
  it('ignores the automatic "still held" checkpoint', () => {
    const at = lastSignOfLife({ ...quiet, checkpoint_summary: untouchedCheckpoint(['CAIRN-277']) }, null)
    expect(at).toBe(new Date(quiet.claimed_at).getTime())
  })

  it('counts a checkpoint that records work, written or automatic', () => {
    const expected = new Date(quiet.checkpoint_at).getTime()
    expect(lastSignOfLife({ ...quiet, checkpoint_summary: 'Guard suite green.' }, null)).toBe(expected)
    expect(lastSignOfLife({ ...quiet, checkpoint_summary: workedCheckpoint('Did it.') }, null)).toBe(expected)
  })

  it('counts a note', () => {
    const note = hoursAgo(0.5)
    expect(lastSignOfLife({ ...quiet, checkpoint_summary: null, checkpoint_at: null }, note)).toBe(
      new Date(note).getTime(),
    )
  })

  it('keeps a claim with a recent sign of life', async () => {
    db.tasks = [claim(1, 'claude-code · Monty', { heartbeat_at: hoursAgo(0.5) })]
    const result = await reconcileClaims(agent('maintenance'))
    expect(result.released).toEqual([])
    expect(result.quiet.map((q) => q.ref)).toEqual(['BB-1'])
  })

  it('releases a claim whose only recent write is the "still held" checkpoint', async () => {
    db.tasks = [
      claim(1, 'openclaw · Monty', {
        checkpoint_at: hoursAgo(0.2),
        checkpoint_summary: untouchedCheckpoint([]),
      }),
    ]
    const result = await reconcileClaims(agent('maintenance'))
    expect(result.released.map((r) => r.ref)).toEqual(['BB-1'])
  })
})

describe('evidence events as signs of life', () => {
  const event = (event: string, actor_id: string, agoHours: number) => ({
    task_id: 'task-1',
    event,
    actor_id,
    created_at: hoursAgo(agoHours),
  })

  it('keeps a claim whose only recent trace is the holder’s commit 30 minutes ago', async () => {
    db.tasks = [claim(1, 'claude-code · Monty')]
    db.events = [event('git_commit', 'claude-code · Monty', 0.5)]
    const result = await reconcileClaims(agent('maintenance'))
    expect(result.released).toEqual([])
    expect(db.rpcs).toEqual([])
  })

  it('releases a claim whose only recent trace is an automatic checkpoint', async () => {
    db.tasks = [claim(1, 'claude-code · Monty')]
    db.events = [event('auto_checkpointed', 'claude-code · Monty', 0.1)]
    const result = await reconcileClaims(agent('maintenance'))
    expect(result.released.map((r) => r.ref)).toEqual(['BB-1'])
  })

  it('does not count a recent event by somebody other than the holder', async () => {
    db.tasks = [claim(1, 'claude-code · Monty')]
    db.events = [event('status_changed', 'Monty', 0.1)]
    const result = await reconcileClaims(agent('maintenance'))
    expect(result.released.map((r) => r.ref)).toEqual(['BB-1'])
  })

  it('keeps the allow and deny lists disjoint, and ownership bookkeeping out', () => {
    const genuine: readonly string[] = CLAIM_EVIDENCE_EVENTS.genuine
    for (const name of CLAIM_EVIDENCE_EVENTS.ignored) expect(genuine).not.toContain(name)
    expect(CLAIM_EVIDENCE_EVENTS.ignored).toEqual(expect.arrayContaining(['auto_checkpointed', 'released', 'claimed']))
  })
})

describe('the note left on release', () => {
  it('says a doing task went back to todo', () => {
    expect(releaseNote(120, true, 'doing')).toContain('Moved back to todo')
  })

  it('says an in-review task stays in review, unclaimed', () => {
    const note = releaseNote(120, false, 'in-review')
    expect(note).toContain('Left in review')
    expect(note).not.toContain('Moved back to todo')
  })
})
