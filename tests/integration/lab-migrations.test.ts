import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Migrations 071-075 (the Lab, CAIRN-366) on fresh databases:
 *
 *  - an instance with no LAB project gets the reservation check;
 *  - an instance that already has one still migrates — a deploy that migrates
 *    on start must never be blocked by a key — and gets the check once the
 *    key is free (cairn_lab_reserve_key, which the settings route calls);
 *  - every Lab migration can run twice.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const LAB_FIRST = '071_'
const clients: Client[] = []

const freshDatabase = async () => {
  const name = `cairn_lab_${randomUUID().replaceAll('-', '')}`
  const root = new Client({ connectionString: databaseUrl })
  await root.connect()
  await root.query(`create database "${name}"`)
  await root.end()
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  clients.push(client)
  return client
}

const migrationFiles = async () =>
  (await readdir(join(process.cwd(), 'migrations'))).filter((f) => f.endsWith('.sql')).sort()

const apply = async (client: Client, files: string[]) => {
  for (const file of files) await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
}

const hasCheck = async (client: Client, name: string) =>
  (await client.query('select 1 from pg_constraint where conname = $1', [name])).rowCount === 1

afterAll(async () => {
  for (const client of clients) await client.end()
})

describe('the Lab migrations', () => {
  it('reserve LAB on an instance that has no LAB project, and seed the nine stages', async () => {
    const client = await freshDatabase()
    await apply(client, await migrationFiles())

    expect(await hasCheck(client, 'projects_key_not_lab')).toBe(true)
    expect(await hasCheck(client, 'project_former_keys_not_lab')).toBe(true)
    const { rows } = await client.query('select name, category from lab_stages order by position')
    expect(rows.map((r) => `${r.name}:${r.category}`)).toEqual([
      'to explore:planned',
      'exploring:active',
      'done:completed',
      'rejected:dropped',
      'to implement:planned',
      'implementing:active',
      'internal testing:active',
      'ready for rollout:active',
      'rolled out:completed',
    ])
    expect((await client.query('select enabled from lab_settings')).rows).toEqual([{ enabled: false }])
  })

  it('still migrate an instance whose project is keyed LAB, and reserve the key once it is free', async () => {
    const client = await freshDatabase()
    const files = await migrationFiles()
    const before = files.filter((f) => f < LAB_FIRST)
    await apply(client, before)

    const owner = randomUUID()
    await client.query(`insert into app_users (id, email, encrypted_password, role) values ($1, 'lab@example.test', 'x', 'admin')`, [owner])
    await client.query(`insert into projects (owner_user_id, key, title) values ($1, 'LAB', 'An old lab')`, [owner])

    await apply(client, files.filter((f) => f >= LAB_FIRST))
    expect(await hasCheck(client, 'projects_key_not_lab')).toBe(false)
    expect((await client.query('select count(*)::int as n from subjects')).rows[0].n).toBe(0)
    expect((await client.query('select cairn_lab_reserve_key() as ok')).rows[0].ok).toBe('key_in_use')

    await client.query(`update projects set key = 'OLDLAB' where key = 'LAB'`)
    // A retired LAB still holds the key, as a live one does.
    await client.query(
      `insert into project_former_keys (key, project_id, owner_user_id) select 'LAB', id, owner_user_id from projects where key = 'OLDLAB'`,
    )
    expect((await client.query('select cairn_lab_reserve_key() as ok')).rows[0].ok).toBe('key_in_use')
    await client.query(`delete from project_former_keys where key = 'LAB'`)

    expect((await client.query('select cairn_lab_reserve_key() as ok')).rows[0].ok).toBe('reserved')
    expect(await hasCheck(client, 'projects_key_not_lab')).toBe(true)
    await expect(client.query(`insert into projects (owner_user_id, key, title) values ($1, 'LAB', 'Again')`, [owner])).rejects.toThrow(
      /projects_key_not_lab/,
    )
  })

  it('add the checks on busy tables NOT VALID, and validate them in a later file', async () => {
    const client = await freshDatabase()
    const files = await migrationFiles()
    const busy = [
      'task_activity_events_event_check',
      'tasks_subject_id_fkey',
      'tasks_handoff_pair_check',
      'tasks_handoff_cairn_url_check',
      'projects_handoff_pair_check',
      'projects_handoff_target_shape_check',
    ]
    const validated = async () =>
      Object.fromEntries(
        (await client.query('select conname, convalidated from pg_constraint where conname = any($1)', [busy])).rows.map(
          (r) => [r.conname, r.convalidated],
        ),
      )

    await apply(client, files.filter((f) => f < '076_'))
    expect(await validated()).toEqual(Object.fromEntries(busy.map((name) => [name, false])))
    // NOT VALID still holds new rows to the rule.
    await expect(
      client.query(`insert into task_activity_events (actor_type, actor_id, event) values ('agent', 'a', 'no_such_event')`),
    ).rejects.toThrow(/task_activity_events_event_check/)

    await apply(client, files.filter((f) => f >= '076_'))
    expect(await validated()).toEqual(Object.fromEntries(busy.map((name) => [name, true])))
  })

  it('can each run twice', async () => {
    const client = await freshDatabase()
    const files = await migrationFiles()
    await apply(client, files)
    const lab = files.filter((f) => f >= LAB_FIRST)
    expect(lab.length).toBeGreaterThanOrEqual(5)
    await apply(client, lab)

    // The transforms are in place once, not twice.
    const search = (await client.query(`select pg_get_functiondef('search_all'::regproc) as d`)).rows[0].d as string
    expect(search.split('select * from subject_rows').length - 1).toBe(1)
    const feed = (
      await client.query(`select pg_get_functiondef('activity_feed(uuid, timestamptz, int, text, text, text[])'::regprocedure) as d`)
    ).rows[0].d as string
    expect(feed.split('select * from subject_notes_').length - 1).toBe(1)
    expect((await client.query('select count(*)::int as n from lab_stages')).rows[0].n).toBe(9)
  })

  it('never reuse a subject number, and let an explicit one move the counter', async () => {
    const client = await freshDatabase()
    await apply(client, await migrationFiles())
    const stage = (await client.query(`select id from lab_stages where name = 'to explore'`)).rows[0].id
    const insert = async (number: number | null) =>
      (
        await client.query(
          `insert into subjects (number, title, stage_id, actor_type, actor_id) values ($1, 's', $2, 'agent', 'a') returning number`,
          [number, stage],
        )
      ).rows[0].number as number

    expect(await insert(null)).toBe(1)
    expect(await insert(null)).toBe(2)
    await client.query('delete from subjects where number = 2')
    expect(await insert(null)).toBe(3)
    expect(await insert(10)).toBe(10)
    expect(await insert(null)).toBe(11)
  })
})
