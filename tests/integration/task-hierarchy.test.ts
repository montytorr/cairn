import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { withHierarchy } from '@/lib/task-hierarchy'

/**
 * The parent, child counts and open dependencies the lists and boards draw
 * (CAIRN-341), through the same adapter the pages use.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const epic = randomUUID()
const childOpen = randomUUID()
const childDone = randomUUID()
const waiting = randomUUID()
const blockerOpen = randomUUID()
const blockerDone = randomUUID()
const loose = randomUUID()

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `hierarchy-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,'HIER','Hierarchy')`, [
    projectId,
    ownerId,
  ])
  const task = (id: string, number: number, status: string, parent: string | null = null) =>
    pool().query(
      `insert into tasks (id, project_id, number, title, actor_id, status, parent_id${['done', 'cancelled'].includes(status) ? ', resolution, resolution_kind' : ''})
       values ($1,$2,$3,$4,'codex · someone',$5,$6${['done', 'cancelled'].includes(status) ? ", 'closed in a test', 'fixed'" : ''})`,
      [id, projectId, number, `task ${number}`, status, parent],
    )
  await task(epic, 1, 'doing')
  await task(childOpen, 2, 'todo', epic)
  await task(childDone, 3, 'done', epic)
  await task(waiting, 4, 'todo')
  await task(blockerOpen, 5, 'doing')
  await task(blockerDone, 6, 'done')
  await task(loose, 7, 'todo')
  for (const blocking of [blockerOpen, blockerDone]) {
    await pool().query('insert into task_deps (blocked_id, blocking_id) values ($1,$2)', [waiting, blocking])
  }
})

afterAll(async () => {
  await pool().query('delete from task_deps where blocked_id = $1', [waiting])
  await pool().query('update tasks set parent_id = null where project_id = $1', [projectId])
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
})

describe('where a task sits among others', () => {
  it('names the parent, counts the children, and lists only the dependencies still open', async () => {
    const rows = await withHierarchy([
      { id: epic, parent_id: null },
      { id: childOpen, parent_id: epic },
      { id: waiting, parent_id: null },
      { id: loose, parent_id: null },
    ])
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get(epic)?.children).toEqual({ closed: 1, total: 2 })
    expect(by.get(childOpen)?.parent_ref).toBe('HIER-1')
    expect(by.get(waiting)?.waiting_on).toEqual(['HIER-5'])
    expect(by.get(loose)).toMatchObject({ parent_ref: null, children: null, waiting_on: [] })
  })

  it('costs nothing for an empty page', async () => {
    expect(await withHierarchy([])).toEqual([])
  })
})
