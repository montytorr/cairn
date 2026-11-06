import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'

/**
 * Migration 090: the reads that ran on every pulse tick and every search are
 * index probes, not whole-table scans.
 *
 * On the Lab instance these two statements read most of 6.8 billion rows:
 * cairn_pulse's max(task_activity_events.created_at) every 4 s per open tab,
 * and staleness's file_touches lookups by path and by session inside every
 * search and recall. A test table is too small for the planner to prefer an
 * index on its own, so each plan is taken with sequential scans switched off:
 * what is proved is that a usable index exists for the exact shape the code
 * sends, which is the part that was missing.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const MIGRATION = readFileSync(join(process.cwd(), 'migrations/090_hot_path_indexes.sql'), 'utf8')

const planOf = async (sql: string, params: unknown[] = []) => {
  const client = await pool().connect()
  try {
    await client.query('begin')
    await client.query('set local enable_seqscan = off')
    const { rows } = await client.query(`explain ${sql}`, params)
    return rows.map((r) => r['QUERY PLAN'] as string).join('\n')
  } finally {
    await client.query('rollback')
    client.release()
  }
}

const indexesOn = async (table: string) => {
  const { rows } = await pool().query(
    `select indexname from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname`,
    [table],
  )
  return rows.map((r) => r.indexname as string)
}

describe('090 hot path indexes', () => {
  it("answers cairn_pulse's newest-activity arm from an index", async () => {
    const plan = await planOf(`select coalesce(max(e.created_at)::text, '-') from task_activity_events e`)
    expect(plan).toContain('task_activity_events_created_idx')
    expect(plan).not.toContain('Seq Scan')
  })

  it('looks up file touches by path the way staleness asks', async () => {
    // staleness.ts: .in('path', [...]).gte('created_at', since).limit(5000),
    // which the query builder renders as `in ($1, $2, ...)`.
    const plan = await planOf(
      `select b."path", b."session_id", b."created_at" from "file_touches" b
        where b."path" in ($1, $2) and b."created_at" >= $3 limit 5000`,
      ['src/a.ts', 'src/b.ts', '2026-01-01T00:00:00Z'],
    )
    expect(plan).toContain('file_touches_path_created_idx')
  })

  it('looks up a single path newest first the way contextForFile asks', async () => {
    const plan = await planOf(
      `select b."path", b."created_at" from "file_touches" b where b."path" = $1 order by b."created_at" desc limit 50`,
      ['src/a.ts'],
    )
    expect(plan).toContain('file_touches_path_created_idx')
  })

  it('looks up file touches by session the way staleness and 060 ask', async () => {
    const plan = await planOf(
      `select b."path", b."session_id" from "file_touches" b where b."session_id" in ($1, $2) limit 2000`,
      ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
    )
    expect(plan).toContain('file_touches_session_idx')
  })

  it('drops the owner-led path index nothing reads', async () => {
    expect(await indexesOn('file_touches')).not.toContain('file_touches_path_idx')
  })

  it('applies again without error and without duplicating an index', async () => {
    const before = await indexesOn('task_activity_events')
    const client = await pool().connect()
    try {
      await client.query('begin')
      await client.query(MIGRATION)
      const { rows } = await client.query(
        `select indexname from pg_indexes where schemaname = 'public' and tablename = 'task_activity_events' order by indexname`,
      )
      expect(rows.map((r) => r.indexname)).toEqual(before)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })

  it('leaves an equivalent index an instance already added under another name alone', async () => {
    const client = await pool().connect()
    try {
      await client.query('begin')
      await client.query('drop index task_activity_events_created_idx')
      await client.query('drop index file_touches_session_idx')
      await client.query('create index hand_made_activity_created on task_activity_events (created_at)')
      await client.query('create index hand_made_touch_session on file_touches (session_id)')
      await client.query(MIGRATION)
      const { rows } = await client.query(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename in ('task_activity_events', 'file_touches')`,
      )
      const names = rows.map((r) => r.indexname as string)
      expect(names).toContain('hand_made_activity_created')
      expect(names).toContain('hand_made_touch_session')
      expect(names).not.toContain('task_activity_events_created_idx')
      expect(names).not.toContain('file_touches_session_idx')
      expect(names).toContain('file_touches_path_created_idx')
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
