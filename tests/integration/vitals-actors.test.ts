import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

/**
 * Vitals says whether a writer is a person.
 *
 * `agent_stats` grouped `task_activity_events` by `actor_id` and nothing else,
 * and `actorLabel` gives a human their display name unqualified while an agent
 * gets `<runtime> · <display name>`. So the owner of the instance was tested
 * by a check coded `agent-silent` and told to investigate his hooks and keys.
 *
 * The fix carries `actor_type` rather than dropping people: the panel these
 * rows feed is titled "Who wrote", and a person writing ninety-seven times a
 * week is a true answer to that. `assess()` is what stops reading them, and
 * its own tests cover that. What is proved HERE is the half a unit test
 * cannot see — that the SQL actually emits the type, since without it every
 * row arrives looking like a runtime again.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const freshDatabase = async () => {
  const name = `cairn_vitals_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: databaseUrl })
  await admin.connect()
  await admin.query(`create database "${name}"`)
  await admin.end()

  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  const files = (await readdir(join(process.cwd(), 'migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
  }
  return client
}

describe('cairn_vitals', () => {
  it('reports people and runtimes, and says which is which', async () => {
    const client = await freshDatabase()
    try {
      const user = randomUUID()
      const project = randomUUID()
      const task = randomUUID()
      await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [
        user,
        `${user}@test`,
        'x',
      ])
      await client.query(
        `insert into projects (id,owner_user_id,key,title) values ($1,$2,'VIT','Vitals')`,
        [project, user],
      )
      await client.query(
        `insert into tasks (id,project_id,number,title,status,type)
         values ($1,$2,1,'a task','doing','chore')`,
        [task, project],
      )

      // Both went quiet in the window and both were busy the week before, so
      // the only thing that can separate them is actor_type.
      const old = `now() - interval '72 hours'`
      for (let i = 0; i < 4; i += 1) {
        await client.query(
          `insert into task_activity_events (task_id,actor_type,actor_id,event,created_at)
           values ($1,'agent','openclaw · Cal','status_changed', ${old})`,
          [task],
        )
        await client.query(
          `insert into task_activity_events (task_id,actor_type,actor_id,event,created_at)
           values ($1,'human','Cal','status_changed', ${old})`,
          [task],
        )
      }

      const { rows } = await client.query('select cairn_vitals($1, 24) as v', [user])
      const agents = (rows[0].v.agents ?? []) as {
        agent: string
        actorType: string
        baseline: number
      }[]

      // Both are reported — "Who wrote" is meant to be the whole picture —
      // and each says what it is, which is the only thing that lets the check
      // tell them apart.
      const byName = new Map(agents.map((a) => [a.agent, a]))
      expect([...byName.keys()].sort()).toEqual(['Cal', 'openclaw · Cal'])
      expect(byName.get('Cal')?.actorType).toBe('human')
      expect(byName.get('openclaw · Cal')?.actorType).toBe('agent')
      // and the runtime's history survives, or the check it feeds goes blind
      expect(byName.get('openclaw · Cal')?.baseline).toBe(4)
    } finally {
      await client.end()
    }
  }, 120_000)

  it('keeps every runtime, including ones that share a person', async () => {
    // Three runtimes under one human is the normal shape here — claude-code,
    // openclaw and codex all write as Cal. Filtering on actor_type must not
    // collapse them, and must not drop the one that is still busy.
    const client = await freshDatabase()
    try {
      const user = randomUUID()
      const project = randomUUID()
      const task = randomUUID()
      await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [
        user,
        `${user}@test`,
        'x',
      ])
      await client.query(
        `insert into projects (id,owner_user_id,key,title) values ($1,$2,'VIT','Vitals')`,
        [project, user],
      )
      await client.query(
        `insert into tasks (id,project_id,number,title,status,type)
         values ($1,$2,1,'a task','doing','chore')`,
        [task, project],
      )

      const write = (actorType: string, actorId: string, when: string) =>
        client.query(
          `insert into task_activity_events (task_id,actor_type,actor_id,event,created_at)
           values ($1,$2,$3,'status_changed', ${when})`,
          [task, actorType, actorId],
        )

      await write('agent', 'claude-code · Cal', `now() - interval '1 hour'`)
      await write('agent', 'openclaw · Cal', `now() - interval '72 hours'`)
      await write('agent', 'codex · Cal', `now() - interval '72 hours'`)
      await write('human', 'Cal', `now() - interval '72 hours'`)

      const { rows } = await client.query('select cairn_vitals($1, 24) as v', [user])
      const agents = (rows[0].v.agents ?? []) as {
        agent: string
        actorType: string
        recent: number
      }[]

      expect(agents.filter((a) => a.actorType === 'agent').map((a) => a.agent).sort()).toEqual([
        'claude-code · Cal',
        'codex · Cal',
        'openclaw · Cal',
      ])
      expect(agents.find((a) => a.agent === 'claude-code · Cal')?.recent).toBe(1)
    } finally {
      await client.end()
    }
  }, 120_000)
})
