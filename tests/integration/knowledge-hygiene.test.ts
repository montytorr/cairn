import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { createKnowledge } from '@/lib/api/knowledge'
import { recallCounts } from '@/lib/api/knowledge-use'
import type { Actor } from '@/lib/api/auth'

/**
 * 064 (CAIRN-289): provenance, sweep-proof recall and length-fair ranking,
 * against the installed SQL.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
// Letters only, so the text-search parser keeps it as one word.
const WORD = `zorblax${suffix.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!)}`
const KEY = `KH${suffix}`
const AGENT = 'claude-code · hygiene@example.test'
const SESSION = `hygiene-session-${suffix}`
const slug = (name: string) => `hygiene-${name}-${suffix}`
const ids: Record<string, string> = {}

const entry = async (name: string, title: string, body: string) => {
  const { rows } = await pool().query(
    `insert into knowledge (owner_user_id, slug, title, body, actor_type, actor_id, created_at)
     values ($1, $2, $3, $4, 'agent', $5, now() - interval '60 days') returning id`,
    [ownerId, slug(name), title, body, AGENT],
  )
  ids[name] = rows[0].id as string
}

const read = (spelled: string, { sweep = false }: { sweep?: boolean } = {}) =>
  pool().query(
    `insert into knowledge_reads (owner_user_id, actor_id, slug, hit, sweep)
     values ($1, $2, $3, true, $4) returning sweep`,
    [ownerId, AGENT, spelled, sweep],
  )

const recalled = async (name: string) => {
  const { rows } = await pool().query('select 1 from knowledge_recall_state where knowledge_id = $1', [ids[name]])
  return rows.length > 0
}

const actor = {
  userId: ownerId,
  actorType: 'agent',
  actorId: AGENT,
  userDisplayName: 'Hygiene',
  role: 'admin',
  rateKey: `hygiene-${ownerId}`,
  sessionId: SESSION,
} as unknown as Actor

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `hygiene-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Hygiene',1)`,
    [projectId, ownerId, KEY],
  )
  await pool().query(
    `insert into tasks (project_id, number, title, actor_type, actor_id, status,
                        claimed_by, claimed_at, heartbeat_at, claimed_session)
     values ($1, 1, 'Held work', 'agent', $2, 'doing', $2, now(), now(), $3)`,
    [projectId, AGENT, SESSION],
  )
  for (let i = 0; i < 12; i += 1) await entry(`sweep-${i}`, `Sweep ${i}`, 'Swept.')
  await entry('declared', 'Declared sweep', 'Swept on purpose.')
  await entry('organic', 'Organic read', 'Read once.')
  await entry('short', `${WORD} pooling`, `${WORD} caps at 15.`)
  await entry(
    'long',
    `${WORD} import`,
    Array.from({ length: 400 }, (_, i) => (i % 80 === 0 ? `${WORD} ` : '') + 'unrelated words about something else').join(' '),
  )
})

afterAll(async () => {
  await pool().query('delete from knowledge_reads where owner_user_id = $1', [ownerId])
  await pool().query('delete from knowledge where owner_user_id = $1', [ownerId])
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('sweeps are reads, not recalls', () => {
  it('tags a burst from the tenth distinct slug in a minute, and keeps it out of recall', async () => {
    const tagged: boolean[] = []
    for (let i = 0; i < 12; i += 1) tagged.push((await read(slug(`sweep-${i}`))).rows[0].sweep as boolean)

    expect(tagged.slice(0, 9)).toEqual(Array(9).fill(false))
    expect(tagged.slice(9)).toEqual([true, true, true])
    expect(await recalled('sweep-8')).toBe(true)
    expect(await recalled('sweep-9')).toBe(false)

    const counts = await recallCounts([ids['sweep-11']!])
    expect(counts.get(ids['sweep-11']!)).toMatchObject({ read: 0 })
  })

  it('honours a declared sweep whatever the rate', async () => {
    await read(slug('declared'), { sweep: true })
    expect(await recalled('declared')).toBe(false)
  })

  it('still counts an ordinary read', async () => {
    await pool().query(
      `insert into knowledge_reads (owner_user_id, actor_id, slug, hit)
       values ($1, 'codex · other@example.test', $2, true)`,
      [ownerId, slug('organic')],
    )
    expect(await recalled('organic')).toBe(true)
  })
})

describe('provenance', () => {
  it('stores the session as named and links the one task it holds', async () => {
    const row = await createKnowledge(actor, {
      slug: slug('provenance'),
      title: 'Provenance is recorded',
      body: 'Learned mid-session.',
      labels: [],
      projects: [],
      entities: [],
    })
    expect(row?.source_session_ref).toBe(SESSION)
    // No sessions row yet: the FK stays empty rather than pointing at nothing.
    expect(row?.source_session_id).toBeNull()
    expect(row?.source_task_id).not.toBeNull()
  })
})

describe('search_all ranks by density, not length (064)', () => {
  it('is installed normalised', async () => {
    const { rows } = await pool().query(
      `select pg_get_functiondef(p.oid) as d from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'search_all'`,
    )
    expect(rows[0].d).toContain('ts_rank(c.vec, q.wide, 1|32)')
    expect(rows[0].d).toContain('ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32)')
  })

  it('puts the short entry above a long one that repeats the word', async () => {
    const { rows } = await pool().query(
      `select ref from search_all($1, $2, null, null, array['knowledge'], 20, 3)`,
      [ownerId, WORD],
    )
    const refs = rows.map((r) => r.ref as string)
    expect(refs).toContain(slug('long'))
    expect(refs.indexOf(slug('short'))).toBeLessThan(refs.indexOf(slug('long')))
  })
})
