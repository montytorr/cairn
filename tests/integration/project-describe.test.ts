import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * `cairn project describe` against a real database and the actual route
 * (CAIRN-374): the description is replaced, who did it is recorded, and an
 * agent's unreadable body is refused with the same list a task body gets.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { PATCH as patchProjectRoute } from '@/app/api/v1/projects/[id]/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const KEY = `PD${String(Date.now()).slice(-6)}`
const AGENT = 'claude-code · describe@example.test'
const WALL = 'WHY EMPTY TODAY: call.controller.search returns nothing for CS users.'

const as = (actorType: 'agent' | 'human') => {
  auth.actor = {
    userId: ownerId,
    actorType,
    actorId: actorType === 'agent' ? AGENT : 'Describer',
    userDisplayName: 'Describer',
    role: 'admin',
    rateKey: `describe-${randomUUID()}`,
    sessionId: null,
    agentName: actorType === 'agent' ? 'claude-code' : undefined,
  }
}

const patch = async (body: Record<string, unknown>) => {
  const response = await patchProjectRoute(
    new Request(`https://cairn.example.test/api/v1/projects/${KEY}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: KEY }) },
  )
  const json = await response.json()
  return { status: response.status, json, data: json?.data }
}

const described = async () =>
  (
    await pool().query<{ actor_id: string; data: { key: string } }>(
      `select actor_id, data from task_activity_events where project_id = $1 and event = 'project_described' order by created_at`,
      [projectId],
    )
  ).rows

const stored = async () =>
  (await pool().query<{ description: string | null }>('select description from projects where id = $1', [projectId])).rows[0]!
    .description

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId,
    `describe-${ownerId}@example.test`,
    'not-used',
    'admin',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title, description) values ($1,$2,$3,'Described','Old text')`, [
    projectId,
    ownerId,
    KEY,
  ])
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from projects where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('PATCH /projects/{id} with a description', () => {
  it('replaces it and records who, without storing the text in the event', async () => {
    as('agent')
    const result = await patch({ description: '## Status\n\nRetired on `2026-10-11`.' })
    expect(result.status).toBe(200)
    expect(result.data.description).toBe('## Status\n\nRetired on `2026-10-11`.')
    expect(await stored()).toBe('## Status\n\nRetired on `2026-10-11`.')
    expect(await described()).toEqual([{ actor_id: AGENT, data: { key: KEY } }])
  })

  it('records nothing when the text did not change', async () => {
    as('agent')
    const before = (await described()).length
    expect((await patch({ description: '## Status\n\nRetired on `2026-10-11`.' })).status).toBe(200)
    expect(await described()).toHaveLength(before)
  })

  it('refuses an agent body that is hard to read, and keeps the old one', async () => {
    as('agent')
    const before = await stored()
    const events = (await described()).length
    const refused = await patch({ description: WALL })
    expect(refused.status).toBe(400)
    expect(refused.json.code).toBe('validation_failed')
    expect(refused.json.field).toBe('description')
    expect(refused.json.problems.length).toBeGreaterThan(0)
    expect(refused.json.error).toContain(`cairn project describe ${KEY} --body -`)
    expect(await stored()).toBe(before)
    expect(await described()).toHaveLength(events)
  })

  it('lets a person type what they like, and clears with null', async () => {
    as('human')
    expect((await patch({ description: WALL })).status).toBe(200)
    const cleared = await patch({ description: null })
    expect(cleared.status).toBe(200)
    expect(await stored()).toBeNull()
    expect((await described()).at(-1)).toEqual({ actor_id: 'Describer', data: { key: KEY } })
  })
})
