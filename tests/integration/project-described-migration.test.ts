import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 077 and 078 (CAIRN-374): `project_described` joins the allowed event kinds
 * without dropping one, the check goes in NOT VALID, and a second run is safe.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const clients: Client[] = []

const freshDatabase = async () => {
  const name = `cairn_pd_${randomUUID().replaceAll('-', '')}`
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

const files = async () =>
  (await readdir(join(process.cwd(), 'migrations'))).filter((f) => f.endsWith('.sql')).sort()

const apply = async (client: Client, names: string[]) => {
  for (const file of names) await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
}

const definition = async (client: Client) =>
  (
    await client.query<{ d: string; convalidated: boolean }>(
      `select pg_get_constraintdef(oid) as d, convalidated from pg_constraint where conname = 'task_activity_events_event_check'`,
    )
  ).rows[0]!

const kinds = (def: string) => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()

afterAll(async () => {
  for (const client of clients) await client.end()
})

describe('migrations 077 and 078', () => {
  it('add project_described, keep every earlier kind, and validate in the second file', async () => {
    const client = await freshDatabase()
    const all = await files()
    await apply(client, all.filter((f) => f < '077_'))
    const before = await definition(client)
    expect(kinds(before.d)).not.toContain('project_described')

    await apply(client, ['077_project_described.sql'])
    const added = await definition(client)
    expect(added.convalidated).toBe(false)
    expect(kinds(added.d)).toEqual([...kinds(before.d), 'project_described'].sort())

    await apply(client, ['078_validate_project_described.sql'])
    expect((await definition(client)).convalidated).toBe(true)

    await client.query(
      `insert into task_activity_events (actor_type, actor_id, event) values ('agent', 'a', 'project_described')`,
    )
  })

  it('can run twice', async () => {
    const client = await freshDatabase()
    const all = await files()
    await apply(client, all)
    await apply(client, all.filter((f) => f >= '077_'))
    expect((await definition(client)).convalidated).toBe(true)
  })
})
