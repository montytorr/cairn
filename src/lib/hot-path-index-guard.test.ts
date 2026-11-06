import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The reads that run constantly keep an index that leads with what they filter on.
 *
 * Both of these scanned whole tables for weeks without anyone noticing, because
 * each one is fast on a small table and nothing fails when it is slow: the Lab
 * instance read 6.8 billion rows at 19 transactions a second (migration 090).
 *
 * - cairn_pulse runs every 4 s for every open tab and takes the newest
 *   task_activity_events.created_at, so it needs an index leading with
 *   created_at.
 * - Knowledge staleness runs inside every search and recall and reads
 *   file_touches by path and by session_id with no owner, so it needs indexes
 *   leading with those columns, not with owner_user_id.
 *
 * Read from the migrations as applied in order, so dropping one of these
 * indexes later, or moving the queries back to an owner-led shape, fails here
 * rather than on a busy instance.
 */
const repo = process.cwd()
const migrations = join(repo, 'migrations')

/** Index name -> definition, after every migration has run in order. */
const indexesAfterAllMigrations = () => {
  const live = new Map<string, string>()
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrations, file), 'utf8').replace(/--.*$/gm, '')
    const events: { at: number; apply: () => void }[] = []
    for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(\w+)\s*(\([^;']*)/gi)) {
      const [, name = '', table = '', rest = ''] = m
      events.push({ at: m.index ?? 0, apply: () => live.set(name, `${table} ${rest.replace(/\s+/g, ' ').trim()}`) })
    }
    for (const m of sql.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(\w+)/gi)) {
      events.push({ at: m.index ?? 0, apply: () => live.delete(m[1] ?? '') })
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply())
  }
  return live
}

const leadsWith = (definitions: Map<string, string>, table: string, column: string) =>
  [...definitions.values()].some((d) => new RegExp(`^${table} \\(\\s*${column}\\b`, 'i').test(d))

describe('hot path indexes', () => {
  const indexes = indexesAfterAllMigrations()

  it('keeps an index leading with created_at for cairn_pulse', () => {
    expect(leadsWith(indexes, 'task_activity_events', 'created_at')).toBe(true)
  })

  it('keeps indexes leading with path and with session_id for staleness', () => {
    expect(leadsWith(indexes, 'file_touches', 'path')).toBe(true)
    expect(leadsWith(indexes, 'file_touches', 'session_id')).toBe(true)
  })

  it('no longer keeps the owner-led path index nothing reads', () => {
    expect(indexes.has('file_touches_path_idx')).toBe(false)
  })

  it('still reads the newest activity unscoped in the latest cairn_pulse', () => {
    // If the pulse ever scopes this arm by owner or project, the index it needs
    // changes; this pins the shape 090 was written for.
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()
    const latest = files
      .map((f) => readFileSync(join(migrations, f), 'utf8'))
      .filter((sql) => /create or replace function cairn_pulse\(/i.test(sql))
      .pop()
    expect(latest).toMatch(/max\(e\.created_at\)[\s\S]{0,40}from task_activity_events e\s*\)/i)
  })

  it('reads file_touches by path and session without an owner filter in staleness', () => {
    const source = readFileSync(join(repo, 'src/lib/api/staleness.ts'), 'utf8')
    expect(source).toMatch(/\.from\('file_touches'\)[\s\S]{0,120}\.in\('path'/)
    expect(source).toMatch(/\.from\('file_touches'\)[\s\S]{0,120}\.in\(column, ids\)/)
    expect(source).not.toMatch(/\.from\('file_touches'\)[\s\S]{0,200}owner_user_id/)
  })
})
