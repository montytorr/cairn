import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The database's list of allowed activity events must contain every event the
 * code can write.
 *
 * `task_activity_events.event` was free text until a migration constrained it
 * to a list. The list was written by hand from the events somebody could see,
 * and missed `resolution_withdrawn` — emitted whenever a task is reopened. Two
 * failures fell out of one omission: the migration could not apply at all,
 * because production already held rows carrying it, and had it applied, the
 * next reopen would have been rejected by the database during normal use.
 *
 * A list maintained by hand beside code that emits values will drift again, so
 * this compares the two rather than trusting either.
 */
const repo = process.cwd()

const allowedByDatabase = () => {
  const dir = join(repo, 'migrations')
  // The last migration that writes the constraint wins, exactly as it does
  // when they are applied in order.
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  let allowed: Set<string> | null = null
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8')
    const match = /constraint\s+task_activity_events_event_check[\s\S]*?check\s*\(event in \(([\s\S]*?)\)\s*\)/i.exec(sql)
    if (!match?.[1]) continue
    allowed = new Set([...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string))
  }
  return allowed
}

const emittedByCode = () => {
  const events = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue
      const source = readFileSync(path, 'utf8')
      for (const m of source.matchAll(/\bevent:\s*'([a-z_]+)'/g)) events.add(m[1] as string)
      for (const m of source.matchAll(/\bpush\(\s*'([a-z_]+)'/g)) events.add(m[1] as string)
      // The field -> event map in activity.ts is a list of tuples, not calls.
      // Keyed on its declaration, not on the word: `TASK_LIST_FIELDS` is
      // imported by routes whose two-item lists are field names, not events.
      for (const m of source.matchAll(/\[\s*'[a-z_]+'\s*,\s*'([a-z_]+)'\s*\]/g)) {
        if (/\bconst FIELDS\b/.test(source)) events.add(m[1] as string)
      }
    }
  }
  walk(join(repo, 'src'))
  return events
}

describe('every activity event the code writes is one the database accepts', () => {
  it('has a constraint to check against', () => {
    expect(allowedByDatabase(), 'no migration defines the event constraint').not.toBeNull()
  })

  it('allows everything the code emits', () => {
    const allowed = allowedByDatabase()
    if (!allowed) return
    const missing = [...emittedByCode()].filter((event) => !allowed.has(event)).sort()
    expect(
      missing,
      `these are written by the code and rejected by the database: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
