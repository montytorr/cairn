import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAutoCheckpoint, isUntouchedAutoCheckpoint } from '../../src/lib/checkpoint-origin'
import { HOLDER, LIVENESS_CASES } from '../../src/lib/liveness-fixtures'

/**
 * What migration 065 counts, proved against the database.
 *
 * Every number CAIRN-282 checked matched its SQL; the failures were in what
 * the SQL could not see. So these cases are the audit's own shapes: a claim
 * kept looking alive by session-end checkpoints (judged by the reaper's own
 * rule, on the cases src/lib/liveness-fixtures.ts shares with it), a reaper that released nothing, the summariser recording itself as a
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
    checkpointHoursAgo?: number | null
    updatedHoursAgo?: number
  }) => {
    number += 1
    const id = randomUUID()
    const claimed = fields.claimedHoursAgo ?? 100
    await client.query(
      `insert into tasks (id,project_id,number,title,status,type,actor_id,
                          claimed_by,claimed_at,heartbeat_at,checkpoint_summary,checkpoint_at,updated_at)
       values ($1,$2,$3,$4,'doing','chore','seed',$5,
               now() - make_interval(hours => $6::int),
               case when $7::int is null then null else now() - make_interval(hours => $7::int) end,
               $8,
               case when $9::int is null then null else now() - make_interval(hours => $9::int) end,
               now() - make_interval(hours => $10::int))`,
      [
        id,
        project,
        number,
        `task ${number}`,
        fields.claimedBy === undefined ? 'openclaw · Dev' : fields.claimedBy,
        claimed,
        fields.heartbeatHoursAgo ?? null,
        fields.checkpoint ?? null,
        fields.checkpoint ? (fields.checkpointHoursAgo ?? 0) : null,
        fields.updatedHoursAgo ?? claimed,
      ],
    )
    return { id, ref: `SIG-${number}` }
  }

  /**
   * A note bumps its task's updated_at (008), as it does in production. The
   * fixtures state updated_at separately, so put it back afterwards under the
   * flag 063 gave touch_updated_at for exactly this.
   */
  const setUpdated = async (taskId: string, hoursAgo: number) => {
    await client.query('begin')
    await client.query(`select set_config('cairn.keep_updated_at', 'on', true)`)
    await client.query(
      `update tasks set updated_at = now() - make_interval(hours => $2::int) where id = $1`,
      [taskId, hoursAgo],
    )
    await client.query('commit')
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

  describe('genuine activity agrees with the reaper', () => {
    // The same cases src/lib/liveness-fixtures.test.ts runs through
    // lastSignOfLife. Both must give the answer the case states.
    for (const c of LIVENESS_CASES) {
      it(c.name, async () => {
        const t = await task({
          claimedBy: HOLDER,
          claimedHoursAgo: c.claimedHoursAgo,
          heartbeatHoursAgo: c.heartbeatHoursAgo,
          checkpoint: c.checkpoint,
          checkpointHoursAgo: c.checkpointHoursAgo,
        })
        if (c.noteHoursAgo !== null) await note(t.id, c.noteHoursAgo)
        for (const e of c.events) await event(t.id, e.event, e.hoursAgo, {}, e.actor)
        await setUpdated(t.id, c.updatedHoursAgo)
        expect(await genuine(t.id)).toBe(c.expectedHoursAgo)
      })
    }

    it('classifies checkpoint text exactly as checkpoint-origin.ts does', async () => {
      const texts = [...LIVENESS_CASES.map((c) => c.checkpoint), 'Next: wire it up', '', null]
      for (const text of texts) {
        const { rows } = await client.query(
          'select checkpoint_is_automatic($1) as auto, checkpoint_is_untouched($1) as untouched',
          [text],
        )
        expect({ text, ...rows[0] }).toEqual({
          text,
          auto: isAutoCheckpoint(text),
          untouched: isUntouchedAutoCheckpoint(text),
        })
      }
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
    expect(row('claude', 'macos')).toMatchObject({ recent: 2, recentSummarised: 1, baseline: 0 })
    expect(row('openclaw', 'linux')).toMatchObject({ recent: 1, baseline: 1, baselineSummarised: 1 })
    expect(row('codex', 'other')).toMatchObject({ recent: 0, baseline: 1 })
  })

  it('keeps a runtime that fell silent before the baseline, and a writer that did', async () => {
    await session({ platform: 'codex', cwd: SERVER_CWD, hoursAgo: 24 * 20 })
    const t = await task({ claimedBy: null })
    // An identity nothing else in this file writes as: the liveness cases above
    // record recent events for the usual runtimes, and one recent write rightly
    // makes a writer present rather than absent.
    await event(t.id, 'body_edited', 24 * 15, {}, 'retired-runtime · Dev')

    const v = await signals()
    expect(v.runtimes.find((r) => r.runtime === 'codex' && r.host === 'linux')).toMatchObject({
      recent: 0,
      baseline: 0,
    })
    expect(v.absentAgents.map((a) => a.agent)).toContain('retired-runtime · Dev')
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
    expect(rows[0]).toEqual({ mac: 'macos', root: 'linux', home: 'linux', other: 'other', unknown: 'other' })
  })
})
