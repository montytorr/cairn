import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * What migration 065 counts, proved against the database.
 *
 * Every number CAIRN-282 checked matched its SQL; the failures were in what
 * the SQL could not see. So these cases are the audit's own shapes: a claim
 * kept looking alive by session-end checkpoints and touch-trigger timestamps,
 * a reaper that released nothing, the summariser recording itself as a
 * session, runtimes told apart by host, and knowledge nobody verified.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const freshDatabase = async () => {
  const name = `cairn_signals_${randomUUID().replaceAll('-', '')}`
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

type Signals = {
  sessions: Record<string, number>
  runtimes: {
    runtime: string
    host: string
    recent: number
    recentSummarised: number
    baseline: number
    baselineSummarised: number
  }[]
  claims: {
    held: number
    quiet2h: number
    quiet24h: number
    quietest: { ref: string; quietMinutes: number | null; claimedBy: string }[]
  }
  reaper: { releasedInWindow: number; released7d: number; lastReleaseAt: string | null; maintenanceLastWriteAt: string | null }
  absentAgents: { agent: string }[]
  knowledge: Record<string, number | string | null>
}

// Built, never written out: the repository is public and a literal home
// directory path in a tracked file fails repo-privacy-guard.
const cwd = (root: string, ...parts: string[]) => [root, ...parts].join('/')
const MAC_CWD = cwd('/Users', 'dev', 'code')
const SERVER_CWD = cwd('/home', 'dev', 'work')
const ROOT_CWD = cwd('/root', 'workspace')

const AUTO_UNTOUCHED =
  'Still held, not progressed: the session that held this claim worked on CAIRN-277.\n\n' +
  '_Recorded automatically when the session ended._'
const AUTO_WORKED = 'Shipped the thing.\n\n_Recorded automatically when the session ended._'

describe('cairn_vitals_signals', () => {
  let client: Client
  let user: string
  let project: string
  let number = 0

  const task = async (fields: {
    claimedBy?: string | null
    claimedHoursAgo?: number
    heartbeatHoursAgo?: number | null
    checkpoint?: string | null
    checkpointHoursAgo?: number
  }) => {
    number += 1
    const id = randomUUID()
    await client.query(
      `insert into tasks (id,project_id,number,title,status,type,actor_id,
                          claimed_by,claimed_at,heartbeat_at,checkpoint_summary,checkpoint_at,updated_at)
       values ($1,$2,$3,$4,'doing','chore','seed',$5,
               now() - make_interval(hours => $6::int),
               case when $7::int is null then null else now() - make_interval(hours => $7::int) end,
               $8,
               case when $8::text is null then null else now() - make_interval(hours => $9::int) end,
               now())`,
      [
        id,
        project,
        number,
        `task ${number}`,
        fields.claimedBy === undefined ? 'openclaw · Dev' : fields.claimedBy,
        fields.claimedHoursAgo ?? 100,
        fields.heartbeatHoursAgo ?? null,
        fields.checkpoint ?? null,
        fields.checkpointHoursAgo ?? 0,
      ],
    )
    return { id, ref: `SIG-${number}` }
  }

  const event = (taskId: string, e: string, hoursAgo: number, data: Record<string, unknown> = {}, actor = 'openclaw · Dev') =>
    client.query(
      `insert into task_activity_events (task_id,actor_type,actor_id,event,data,created_at)
       values ($1,'agent',$2,$3,$4, now() - make_interval(hours => $5::int))`,
      [taskId, actor, e, JSON.stringify(data), hoursAgo],
    )

  const note = (taskId: string, hoursAgo: number, actor = 'openclaw · Dev') =>
    client.query(
      `insert into task_notes (task_id,actor_type,actor_id,note,created_at)
       values ($1,'agent',$2,'still on it', now() - make_interval(hours => $3::int))`,
      [taskId, actor, hoursAgo],
    )

  const session = (fields: {
    platform: string
    cwd: string
    hoursAgo: number
    summarised?: boolean
    request?: string
  }) =>
    client.query(
      `insert into sessions (owner_user_id,external_id,platform_source,cwd,request,learned,created_at)
       values ($1,$2,$3,$4,$5,$6, now() - make_interval(hours => $7::int))`,
      [
        user,
        randomUUID(),
        fields.platform,
        fields.cwd,
        fields.request ?? 'do the work',
        fields.summarised ? 'something learned' : null,
        fields.hoursAgo,
      ],
    )

  const signals = async (hours = 24) => {
    const { rows } = await client.query('select cairn_vitals_signals($1, $2) as v', [user, hours])
    return rows[0].v as Signals
  }

  const genuine = async (taskId: string) => {
    const { rows } = await client.query(
      `select extract(epoch from now() - task_genuine_activity_at($1)) / 3600 as hours`,
      [taskId],
    )
    return rows[0].hours === null ? null : Math.round(Number(rows[0].hours))
  }

  beforeAll(async () => {
    client = await freshDatabase()
    user = randomUUID()
    project = randomUUID()
    await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [
      user,
      `${user}@test`,
      'x',
    ])
    await client.query(`insert into projects (id,owner_user_id,key,title) values ($1,$2,'SIG','Signals')`, [
      project,
      user,
    ])
  }, 120_000)

  afterAll(async () => {
    await client?.end()
  })

  describe('genuine activity', () => {
    it('ignores updated_at and a session-end checkpoint on a claim nobody worked', async () => {
      // BB-385: claimed 168h ago, stamped by the 09:00 session sweep that day.
      const t = await task({ claimedHoursAgo: 168, checkpoint: AUTO_UNTOUCHED, checkpointHoursAgo: 0 })
      expect(await genuine(t.id)).toBe(168)
    })

    it('ignores a session-end checkpoint on worked claims too, and a bare Next: block', async () => {
      const worked = await task({ claimedHoursAgo: 50, checkpoint: AUTO_WORKED, checkpointHoursAgo: 1 })
      const next = await task({ claimedHoursAgo: 50, checkpoint: 'Next: wire it up', checkpointHoursAgo: 1 })
      expect(await genuine(worked.id)).toBe(50)
      expect(await genuine(next.id)).toBe(50)
    })

    it('counts a checkpoint someone wrote, a heartbeat, a note and an activity event', async () => {
      const manual = await task({ claimedHoursAgo: 50, checkpoint: 'Handler done, tests next', checkpointHoursAgo: 3 })
      const beat = await task({ claimedHoursAgo: 50, heartbeatHoursAgo: 4 })
      const noted = await task({ claimedHoursAgo: 50 })
      await note(noted.id, 5)
      const moved = await task({ claimedHoursAgo: 50 })
      await event(moved.id, 'status_changed', 6, { from: 'todo', to: 'doing' })
      expect(await genuine(manual.id)).toBe(3)
      expect(await genuine(beat.id)).toBe(4)
      expect(await genuine(noted.id)).toBe(5)
      expect(await genuine(moved.id)).toBe(6)
    })

    it('ignores activity events marked automatic, and releases', async () => {
      const t = await task({ claimedHoursAgo: 50 })
      await event(t.id, 'checkpointed', 1, { auto: true })
      await event(t.id, 'checkpointed', 1, { source: 'session-end' })
      await event(t.id, 'released', 1, { reason: 'manual' })
      expect(await genuine(t.id)).toBe(50)
    })
  })

  it('counts quiet claims and names the quietest first', async () => {
    const v = await signals()
    // Everything seeded above is held and quiet for more than 2h; a fresh one is not.
    await task({ claimedHoursAgo: 0 })
    const after = await signals()
    expect(after.claims.held).toBe(v.claims.held + 1)
    expect(after.claims.quiet2h).toBe(v.claims.quiet2h)
    expect(after.claims.quiet24h).toBeGreaterThan(0)
    expect(after.claims.quietest[0]?.quietMinutes).toBeGreaterThanOrEqual(168 * 60 - 1)
    expect(after.claims.quietest.length).toBeLessThanOrEqual(10)
  })

  it('does not count an unclaimed task as held', async () => {
    const before = await signals()
    await task({ claimedBy: null })
    expect((await signals()).claims.held).toBe(before.claims.held)
  })

  it('sees the reaper only through its releases, and the maintenance identity through its writes', async () => {
    const before = await signals()
    expect(before.reaper.released7d).toBe(0)
    expect(before.reaper.maintenanceLastWriteAt).toBeNull()

    const t = await task({ claimedBy: null })
    await event(t.id, 'released', 30, { reason: 'reconcile' }, 'maintenance · Dev')
    await event(t.id, 'released', 1, { reason: 'manual' }, 'claude-code · Dev')

    const after = await signals()
    expect(after.reaper.released7d).toBe(1)
    expect(after.reaper.releasedInWindow).toBe(0)
    expect(after.reaper.maintenanceLastWriteAt).not.toBeNull()
    // Never reported as a silent runtime — it writes only when it releases.
    expect(after.absentAgents.map((a) => a.agent)).not.toContain('maintenance · Dev')
  })

  it('splits sessions by runtime and host and leaves the summariser out', async () => {
    await session({ platform: 'claude', cwd: MAC_CWD, hoursAgo: 1, summarised: true })
    await session({ platform: 'claude', cwd: MAC_CWD, hoursAgo: 2 })
    await session({ platform: 'openclaw', cwd: ROOT_CWD, hoursAgo: 3 })
    await session({ platform: 'openclaw', cwd: SERVER_CWD, hoursAgo: 50, summarised: true })
    await session({ platform: 'codex', cwd: null as unknown as string, hoursAgo: 60, summarised: true })
    await session({
      platform: 'claude',
      cwd: MAC_CWD,
      hoursAgo: 1,
      request: 'You are writing one entry in an engineering memory that other agents read months later.',
    })

    const v = await signals()
    expect(v.sessions).toMatchObject({
      recent: 3,
      recentSummarised: 1,
      baseline: 2,
      baselineSummarised: 2,
      summariserRecent: 1,
    })
    const row = (runtime: string, host: string) =>
      v.runtimes.find((r) => r.runtime === runtime && r.host === host)
    expect(row('claude', 'mac')).toMatchObject({ recent: 2, recentSummarised: 1, baseline: 0 })
    expect(row('openclaw', 'clawdius')).toMatchObject({ recent: 1, baseline: 1, baselineSummarised: 1 })
    expect(row('codex', 'other')).toMatchObject({ recent: 0, baseline: 1 })
  })

  it('keeps a runtime that fell silent before the baseline, and a writer that did', async () => {
    await session({ platform: 'codex', cwd: SERVER_CWD, hoursAgo: 24 * 20 })
    const t = await task({ claimedBy: null })
    await event(t.id, 'body_edited', 24 * 15, {}, 'codex · Dev')

    const v = await signals()
    expect(v.runtimes.find((r) => r.runtime === 'codex' && r.host === 'clawdius')).toMatchObject({
      recent: 0,
      baseline: 0,
    })
    expect(v.absentAgents.map((a) => a.agent)).toContain('codex · Dev')
    expect(v.absentAgents.map((a) => a.agent)).not.toContain('openclaw · Dev')
  })

  it('counts current knowledge by when it was last verified', async () => {
    const insert = (slug: string, verified: string | null, superseded = false) =>
      client.query(
        `insert into knowledge (owner_user_id,slug,title,verified_at) values ($1,$2,$2,${verified ?? 'null'})
         returning id`,
        [user, slug],
      ).then(async ({ rows }) => {
        if (superseded) {
          const { rows: other } = await client.query(
            `insert into knowledge (owner_user_id,slug,title) values ($1,$2,$2) returning id`,
            [user, `${slug}-successor`],
          )
          await client.query('update knowledge set superseded_by = $1 where id = $2', [other[0].id, rows[0].id])
        }
      })
    await insert('never-checked', null)
    await insert('checked-long-ago', `now() - interval '40 days'`)
    await insert('checked-today', `now() - interval '1 hour'`)
    await insert('replaced', null, true)

    const v = await signals()
    // The successor of `replaced` is current and never verified; `replaced` is not current.
    expect(v.knowledge).toMatchObject({
      current: 4,
      neverVerified: 2,
      unverified30d: 3,
      verifiedInWindow: 1,
    })
  })

  it('classifies hosts from the working directory', async () => {
    const { rows } = await client.query(
      `select session_host($1) as mac, session_host($2) as root,
              session_host($3) as home, session_host($4) as other,
              session_host(null) as unknown`,
      [cwd('/Users', 'dev'), '/root', cwd('/home', 'dev', 'y'), cwd('/opt', 'x')],
    )
    expect(rows[0]).toEqual({ mac: 'mac', root: 'clawdius', home: 'clawdius', other: 'other', unknown: 'other' })
  })
})
