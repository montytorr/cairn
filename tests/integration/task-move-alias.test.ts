import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { resolveTask } from '@/lib/api/tasks'
import { searchAll } from '@/lib/api/search'
import type { Actor } from '@/lib/api/auth'

/**
 * A moved task keeps resolving under the ref it was filed under, against the
 * installed `move_task` and `task_former_refs`.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const A = `MA${suffix}`
const B = `MB${suffix}`
const C = `MC${suffix}`
const A_RENAMED = `MR${suffix}`
const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() }
const mover = 'claude-code · move@example.test'

const actor = {
  userId: ownerId,
  actorType: 'agent',
  actorId: mover,
  userDisplayName: 'Move',
  role: 'admin',
  rateKey: `move-${ownerId}`,
  sessionId: null,
} as unknown as Actor

const addTask = async (projectId: string, title: string) => {
  const id = randomUUID()
  await pool().query(
    `insert into tasks (id, project_id, title, actor_type, actor_id, status)
     values ($1,$2,$3,'agent',$4,'todo')`,
    [id, projectId, title, mover],
  )
  return id
}

const move = async (task: string, project: string) =>
  (await pool().query('select * from move_task($1,$2,$3)', [ownerId, task, project])).rows[0] as {
    number: number
    project_key: string
  }

const numberOf = async (task: string) =>
  (await pool().query('select number from tasks where id = $1', [task])).rows[0].number as number

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `move-${ownerId}@example.test`,
    'not-used',
  ])
  for (const [id, key] of [[ids.a, A], [ids.b, B], [ids.c, C]] as const) {
    await pool().query(
      `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,$3,0)`,
      [id, ownerId, key],
    )
  }
})

afterAll(async () => {
  await pool().query('delete from projects where id = any($1)', [Object.values(ids)])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('a moved task keeps its former ref', () => {
  it('resolves the old ref to the task at its new ref, and says so', async () => {
    const task = await addTask(ids.a, 'Wanderer one')
    const oldNumber = await numberOf(task)
    const moved = await move(task, ids.b)
    expect(moved.project_key).toBe(B)

    const resolved = await resolveTask(actor, `${A}-${oldNumber}`)
    expect(resolved.task?.id).toBe(task)
    expect(resolved.renamed).toBeNull()
    expect(resolved.moved).toMatchObject({ ref: `${A}-${oldNumber}`, to: `${B}-${moved.number}` })
    expect(resolved.requestedRef).toBe(`${A}-${oldNumber}`)

    const current = await resolveTask(actor, `${B}-${moved.number}`)
    expect(current.task?.id).toBe(task)
    expect(current.moved ?? null).toBeNull()
  })

  it('follows a chain A to B to C, every former ref reaching the same task', async () => {
    const task = await addTask(ids.a, 'Wanderer two')
    const numberInA = await numberOf(task)
    const inB = await move(task, ids.b)
    const inC = await move(task, ids.c)

    for (const ref of [`${A}-${numberInA}`, `${B}-${inB.number}`]) {
      const resolved = await resolveTask(actor, ref)
      expect(resolved.task?.id).toBe(task)
      expect(resolved.moved).toMatchObject({ to: `${C}-${inC.number}` })
    }
  })

  it('gives a task moved back a new number, with both former refs on it', async () => {
    const task = await addTask(ids.a, 'Wanderer three')
    const first = await numberOf(task)
    const inB = await move(task, ids.b)
    const back = await move(task, ids.a)
    expect(back.number).not.toBe(first)

    const viaFirst = await resolveTask(actor, `${A}-${first}`)
    const viaB = await resolveTask(actor, `${B}-${inB.number}`)
    expect(viaFirst.task?.id).toBe(task)
    expect(viaB.task?.id).toBe(task)
    expect(viaFirst.moved).toMatchObject({ to: `${A}-${back.number}` })
  })

  it('lets a live task win over an alias', async () => {
    const task = await addTask(ids.a, 'Leaver')
    const number = await numberOf(task)
    await move(task, ids.b)
    // Force the collision the counter normally rules out.
    await pool().query(
      `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
       values ($1,$2,$3,'Squatter','agent',$4,'todo')`,
      [randomUUID(), ids.a, number, mover],
    )

    const resolved = await resolveTask(actor, `${A}-${number}`)
    expect(resolved.task?.title).toBe('Squatter')
    expect(resolved.moved ?? null).toBeNull()
  })

  it('still resolves after the source project is renamed', async () => {
    const task = await addTask(ids.a, 'Wanderer four')
    const number = await numberOf(task)
    await move(task, ids.b)
    await pool().query('select project_rename_key($1, $2, $3)', [ids.a, A_RENAMED, mover])

    for (const key of [A, A_RENAMED]) {
      const resolved = await resolveTask(actor, `${key}-${number}`)
      expect(resolved.task?.id).toBe(task)
      expect(resolved.moved).toMatchObject({ ref: `${key}-${number}` })
    }
  })

  it('is found by an exact-ref search on the old ref', async () => {
    const task = await addTask(ids.b, 'Searchable wanderer')
    const number = await numberOf(task)
    const moved = await move(task, ids.c)

    const { rows } = await searchAll(ownerId, `${B}-${number}`, {}, 10)
    const hit = rows.find((row) => row.id === task)
    expect(hit).toMatchObject({ ref: `${C}-${moved.number}`, requested_ref: `${B}-${number}` })
    expect(hit?.moved_from).toMatchObject({ ref: `${B}-${number}`, to: `${C}-${moved.number}` })
  })

  it('removes the alias with the task', async () => {
    const task = await addTask(ids.a, 'Short lived')
    await move(task, ids.b)
    await pool().query('delete from tasks where id = $1', [task])
    const { rows } = await pool().query('select 1 from task_former_refs where task_id = $1', [task])
    expect(rows).toHaveLength(0)
  })
})
