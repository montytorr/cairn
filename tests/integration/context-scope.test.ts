import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { buildContext } from '@/lib/api/context'
import type { Actor } from '@/lib/api/auth'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const owner = randomUUID()
const currentId = randomUUID()
const otherId = randomUUID()
const currentKey = `C${owner.slice(0, 7).toUpperCase()}`
const otherKey = `O${owner.slice(0, 7).toUpperCase()}`
const agent = `scope-test-${owner}`
const cwd = `/context-scope/${owner}`
const actor = { userId: owner, actorId: agent, actorType: 'agent', role: 'member',
  rateKey: agent, userDisplayName: 'Scope test', sessionId: null } satisfies Actor

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)',
    [owner, `context-${owner}@example.test`, 'not-used'])
  await pool().query('insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,$4), ($5,$2,$6,$7)',
    [currentId, owner, currentKey, 'Current', otherId, otherKey, 'Other'])
  for (const [projectId, number, title, claimedAt] of [
    [otherId, 1, 'Other work', '2020-01-01T00:00:00Z'],
    [currentId, 1, 'Current work', '2020-01-02T00:00:00Z'],
  ] as const) {
    await pool().query(
      `insert into tasks (id, project_id, number, title, status, type, actor_id, claimed_by, claimed_at, heartbeat_at)
       values ($1,$2,$3,$4,'doing','chore',$5,$5,$6,$6)`,
      [randomUUID(), projectId, number, title, agent, claimedAt],
    )
  }
  for (const [projectId, request, endedAt] of [
    [currentId, 'Current session', '2020-01-01T00:00:00Z'],
    [otherId, 'Other session', '2020-01-02T00:00:00Z'],
    [null, 'Unclassified session', '2020-01-03T00:00:00Z'],
  ] as const) {
    await pool().query(
      `insert into sessions (owner_user_id, project_id, external_id, platform_source, cwd, request, ended_at)
       values ($1,$2,$3,'other',$4,$5,$6)`,
      [owner, projectId, randomUUID(), cwd, request, endedAt],
    )
  }
})

afterAll(async () => {
  await pool().query('delete from sessions where owner_user_id = $1', [owner])
  await pool().query('delete from tasks where project_id in ($1,$2)', [currentId, otherId])
  await pool().query('delete from projects where owner_user_id = $1', [owner])
  await pool().query('delete from app_users where id = $1', [owner])
})

it('scopes real joined queries for held work, stale claims, and the last session', async () => {
  const scoped = await buildContext(actor, { cwd, project: currentKey, scope: 'project' })
  expect(scoped.held.map((item) => item.title)).toEqual(['Current work'])
  expect(scoped.staleClaims.map((item) => item.title)).toEqual(['Current work'])
  expect(scoped.lastSession?.request).toBe('Current session')

  const unscoped = await buildContext(actor, { cwd, project: currentKey })
  expect(unscoped.held.map((item) => item.title)).toEqual(['Other work', 'Current work'])
  expect(unscoped.lastSession?.request).toBe('Unclassified session')
})

it('rejects an unknown explicit project key even with a matching cwd', async () => {
  const unknownKey = `X${owner.slice(0, 7).toUpperCase()}`
  await expect(buildContext(actor, { cwd, project: unknownKey, scope: 'project' }))
    .rejects.toThrow('Project not found')
})
