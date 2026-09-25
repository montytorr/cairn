import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'
import { sessionUpsert } from '@/schemas/session'

const state = vi.hoisted(() => ({
  written: [] as Record<string, unknown>[],
  repos: {} as Record<string, string>,
  cwds: {} as Record<string, string>,
  names: {} as Record<string, string>,
  failLookups: false,
}))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        state.written.push(row)
        return {
          select: () => ({ single: async () => ({ data: { id: 'session-id', ...row }, error: null }) }),
        }
      },
    }),
  }),
  normalizeDatabaseValue: (v: unknown) => v,
  pool: {},
}))
vi.mock('./files', () => ({ recordFiles: async () => undefined }))
vi.mock('./project-keys', () => ({
  resolveProject: async (key: string) => (key === 'GONE' ? null : { project: { id: `id-${key}`, key } }),
}))
vi.mock('./project-resolution', () => ({
  projectForRepo: async (_u: string, remote: string) => {
    if (state.failLookups) throw new Error('db down')
    return state.repos[remote] ?? null
  },
  projectForCwd: async (_u: string, cwd: string) => state.cwds[cwd] ?? null,
  projectForCheckoutName: async (_u: string, cwd: string) => state.names[cwd] ?? null,
}))

import { upsertSession } from './sessions'

/** Absolute fixture paths, built so no real home directory is spelled out. */
const p = (...parts: string[]) => ['', ...parts].join('/')
const MAC_HM = p('Users', 'dev', 'hm')
const SERVER_CAIRN = p('home', 'dev', 'cairn')

const actor = { userId: 'u', actorId: null, userDisplayName: 'dev' } as unknown as Actor
const upsert = (input: Record<string, unknown>) =>
  upsertSession(actor, sessionUpsert.parse({ externalId: 'x', checkpointHeld: false, ...input }))

/**
 * CAIRN-286: 389 of 389 live sessions had no project, because the server only
 * ever used a key the caller sent and no caller sent one. It now follows the
 * same order `cairn context` does: the key, the remote, then the directory.
 */
describe('which project a recorded session belongs to', () => {
  beforeEach(() => {
    state.written = []
    state.repos = { 'git@github.com:montytorr/cairn.git': 'CAIRN' }
    state.cwds = { [MAC_HM]: 'HM' }
    state.names = { [SERVER_CAIRN]: 'CAIRN', [MAC_HM]: 'NOPE' }
    state.failLookups = false
  })

  it('uses the key the caller sent', async () => {
    await upsert({ project: 'DC', repo: 'git@github.com:montytorr/cairn.git', cwd: '/x' })
    expect(state.written[0]?.project_id).toBe('id-DC')
  })

  it('falls back to the remote when the key is unknown or absent', async () => {
    await upsert({ project: 'GONE', repo: 'git@github.com:montytorr/cairn.git' })
    await upsert({ repo: 'git@github.com:montytorr/cairn.git' })
    expect(state.written.map((r) => r.project_id)).toEqual(['id-CAIRN', 'id-CAIRN'])
  })

  it('then to sessions already attributed in the same directory', async () => {
    await upsert({ cwd: MAC_HM })
    expect(state.written[0]?.project_id).toBe('id-HM')
  })

  it('then to the checkout name, for an older CLI that sends only a cwd', async () => {
    await upsert({ cwd: SERVER_CAIRN })
    expect(state.written[0]?.project_id).toBe('id-CAIRN')
  })

  it('records the session unattributed rather than failing when a lookup breaks', async () => {
    state.failLookups = true
    await upsert({ repo: 'git@github.com:montytorr/cairn.git', cwd: SERVER_CAIRN })
    expect(state.written[0]?.project_id).toBeNull()
  })

  it('leaves a session with nothing to go on unattributed', async () => {
    await upsert({ cwd: '/tmp/elsewhere' })
    expect(state.written[0]?.project_id).toBeNull()
  })
})
