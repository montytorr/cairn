import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A task may carry an external ref: where it came from in another tool.
 *
 * Against a real database and the actual route handlers, because the contract
 * rests on the unique index from migration 002: a create with a held ref is a
 * retry, two creates racing past the lookup must still produce one task, and
 * an update onto a held ref has to come back as a 409 that says whose it is
 * rather than a bare constraint name. Rows an import wrote straight into
 * `external_ref` have to behave the same as rows the API wrote.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { GET as showTask, PATCH as patchRoute } from '@/app/api/v1/tasks/[ref]/route'
import { POST as createRoute, GET as listRoute } from '@/app/api/v1/projects/[id]/tasks/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://cairn.example.test'
const ownerId = randomUUID()
const projectId = randomUUID()
const otherProjectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const KEY = `XR${suffix}`
const OTHER_KEY = `XS${suffix}`
const AGENT = 'claude-code · external-refs@example.test'
const prefix = `ext-${randomUUID()}`
const refOf = (name: string) => `${prefix}:${name}`

const jsonHeaders = { 'content-type': 'application/json', authorization: 'Bearer test' }

beforeEach(() => {
  auth.actor = {
    userId: ownerId,
    actorType: 'agent',
    actorId: AGENT,
    userDisplayName: 'External Refs',
    role: 'admin',
    rateKey: `external-refs-${randomUUID()}`,
    sessionId: null,
    agentName: 'claude-code',
  }
})

const create = (project: string, body: Record<string, unknown>) =>
  createRoute(new Request(`${ORIGIN}/api/v1/projects/${project}/tasks`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: project }) })

const update = (ref: string, body: Record<string, unknown>) =>
  patchRoute(new Request(`${ORIGIN}/api/v1/tasks/${ref}`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body),
  }), { params: Promise.resolve({ ref }) })

const show = (ref: string, view = '') =>
  showTask(new Request(`${ORIGIN}/api/v1/tasks/${ref}${view}`), { params: Promise.resolve({ ref }) })

const list = (project: string, query: string) =>
  listRoute(new Request(`${ORIGIN}/api/v1/projects/${project}/tasks?${query}`), { params: Promise.resolve({ id: project }) })

const count = async (externalRef: string) =>
  Number((await pool().query('select count(*) from tasks where external_ref = $1', [externalRef])).rows[0].count)

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId, `external-refs-${ownerId}@example.test`, 'not-used', 'admin',
  ])
  for (const [id, key] of [[projectId, KEY], [otherProjectId, OTHER_KEY]]) {
    await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'External refs')`, [id, ownerId, key])
  }
  // What an import writes: straight into the column, with no API involved.
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, external_ref, external_url)
     values ($1,$2,900,'Imported','agent',$3,$4,'https://legacy.example.test/9')`,
    [randomUUID(), projectId, AGENT, refOf('imported')],
  )
  await pool().query('update projects set task_counter = 900 where id = $1', [projectId])
})

afterAll(async () => {
  await pool().query('delete from tasks where project_id = any($1::uuid[])', [[projectId, otherProjectId]])
  await pool().query('delete from projects where id = any($1::uuid[])', [[projectId, otherProjectId]])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('creating with an external ref', () => {
  it('stores the ref and the url and says so in the response', async () => {
    const response = await create(KEY, { title: 'From elsewhere', externalRef: refOf('first'), externalUrl: 'https://example.test/first' })
    expect(response.status).toBe(201)
    const { data } = await response.json()
    expect(data).toMatchObject({ title: 'From elsewhere', external_ref: refOf('first'), external_url: 'https://example.test/first' })
    expect(data.duplicate).toBeUndefined()
    const { rows } = await pool().query('select external_ref, external_url from tasks where id = $1', [data.id])
    expect(rows[0]).toEqual({ external_ref: refOf('first'), external_url: 'https://example.test/first' })
  })

  it('returns the existing task, 200 and duplicate, instead of filing a second', async () => {
    const first = (await (await create(KEY, { title: 'Once', externalRef: refOf('again') })).json()).data
    const retry = await create(KEY, { title: 'Once, retried', externalRef: refOf('again'), priority: 'urgent' })
    expect(retry.status).toBe(200)
    const { data } = await retry.json()
    expect(data).toMatchObject({ duplicate: true, id: first.id, ref: first.ref, title: 'Once', priority: 'medium' })
    expect(await count(refOf('again'))).toBe(1)
  })

  it('finds it from another project too, because the ref is unique to the instance', async () => {
    const first = (await (await create(KEY, { title: 'Filed here', externalRef: refOf('across') })).json()).data
    const elsewhere = await create(OTHER_KEY, { title: 'Filed there', externalRef: refOf('across') })
    expect(elsewhere.status).toBe(200)
    expect((await elsewhere.json()).data).toMatchObject({ duplicate: true, id: first.id, ref: first.ref })
    expect(await count(refOf('across'))).toBe(1)
  })

  it('treats a row an import wrote as the same thing', async () => {
    const response = await create(KEY, { title: 'Again', externalRef: refOf('imported') })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ duplicate: true, title: 'Imported', external_url: 'https://legacy.example.test/9', ref: `${KEY}-900` })
  })

  it('files exactly one task when two creates race', async () => {
    const responses = await Promise.all([1, 2, 3, 4].map((n) => create(KEY, { title: `Racer ${n}`, externalRef: refOf('race') })))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 201])
    const bodies = await Promise.all(responses.map(async (r) => (await r.json()).data))
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1)
    expect(await count(refOf('race'))).toBe(1)
  })

  it('files tasks with no ref as separate tasks, as before', async () => {
    const a = await create(KEY, { title: 'Plain twin' })
    const b = await create(KEY, { title: 'Plain twin' })
    expect([a.status, b.status]).toEqual([201, 201])
  })

  it('refuses a malformed ref or url before anything is written', async () => {
    for (const body of [{ externalRef: 'has space' }, { externalRef: '' }, { externalUrl: 'ftp://example.test/x' }]) {
      const response = await create(KEY, { title: 'Bad', ...body })
      expect(response.status).toBe(400)
    }
  })

  it('refuses a secret in the ref or the url, naming the field and never the value', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    for (const [field, value] of [['externalRef', token], ['externalUrl', `https://example.test/x?token=${token}`]] as const) {
      const response = await create(KEY, { title: 'Leaky', [field]: value })
      expect(response.status).toBe(400)
      const text = await response.text()
      expect(text).toContain('secret_detected')
      expect(text).toContain(field)
      expect(text).not.toContain(token)
    }
    expect(await count(token)).toBe(0)
  })
})

describe('reading and filtering by external ref', () => {
  it('shows it on the full task and in the digest', async () => {
    const created = (await (await create(KEY, { title: 'Shown', externalRef: refOf('shown'), externalUrl: 'https://example.test/shown' })).json()).data
    expect((await (await show(created.ref)).json()).data).toMatchObject({ external_ref: refOf('shown'), external_url: 'https://example.test/shown' })
    expect((await (await show(created.ref, '?view=digest')).json()).data).toMatchObject({ externalRef: refOf('shown'), externalUrl: 'https://example.test/shown' })
  })

  it('lists by an exact match only', async () => {
    await create(KEY, { title: 'Longer ref', externalRef: `${refOf('exact')}-2` })
    await create(KEY, { title: 'Exact ref', externalRef: refOf('exact') })
    const { data } = await (await list(KEY, `external_ref=${encodeURIComponent(refOf('exact'))}`)).json()
    expect(data.tasks.map((t: { title: string }) => t.title)).toEqual(['Exact ref'])
    expect(data.tasks[0].external_ref).toBe(refOf('exact'))
    const none = await (await list(KEY, 'external_ref=nothing-has-this')).json()
    expect(none.data.tasks).toEqual([])
  })
})

describe('updating an external ref', () => {
  it('sets, changes and clears it', async () => {
    const task = (await (await create(KEY, { title: 'Moving ref' })).json()).data
    const set = await update(task.ref, { externalRef: refOf('upd-1'), externalUrl: 'https://example.test/1' })
    expect(set.status).toBe(200)
    expect((await set.json()).data).toMatchObject({ external_ref: refOf('upd-1'), external_url: 'https://example.test/1' })

    const changed = await update(task.ref, { externalRef: refOf('upd-2') })
    expect((await changed.json()).data).toMatchObject({ external_ref: refOf('upd-2'), external_url: 'https://example.test/1' })

    const cleared = await update(task.ref, { externalRef: null, externalUrl: null })
    expect((await cleared.json()).data).toMatchObject({ external_ref: null, external_url: null })
    expect(await count(refOf('upd-2'))).toBe(0)
  })

  it('refuses a ref another task holds, naming that task, and leaves both alone', async () => {
    const holder = (await (await create(KEY, { title: 'Holder', externalRef: refOf('held') })).json()).data
    const other = (await (await create(KEY, { title: 'Wants it' })).json()).data
    const response = await update(other.ref, { externalRef: refOf('held') })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toContain(holder.ref)
    expect(body.code).toBe('conflict')
    expect(await count(refOf('held'))).toBe(1)
  })

  it('lets a ref be kept when the same task is updated again', async () => {
    const task = (await (await create(KEY, { title: 'Stays', externalRef: refOf('stays') })).json()).data
    const response = await update(task.ref, { externalRef: refOf('stays'), priority: 'high' })
    expect(response.status).toBe(200)
  })

  it('frees a cleared ref for another task', async () => {
    const first = (await (await create(KEY, { title: 'First owner', externalRef: refOf('free') })).json()).data
    await update(first.ref, { externalRef: null })
    const second = await create(KEY, { title: 'Second owner', externalRef: refOf('free') })
    expect(second.status).toBe(201)
  })
})
