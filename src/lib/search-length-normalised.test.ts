import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 064 normalises search_all's rank by document length, by editing the
 * definition that is INSTALLED: 038's body, as 048 stripped its owner
 * predicates and 055 rewrote both arms. This rebuilds that text the way
 * search-both-arms.test.ts does and applies 064's anchors to it, because a
 * `replace` that finds nothing reports success.
 */

const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8')

const asInstalledBy048 = (sql: string) =>
  sql
    .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner\s+and\s+/g, '')
    .replace(/where\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'where true')
    .replace(/and\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'and true')

const blocks = (sql: string, tag: string) =>
  [...sql.matchAll(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, 'g'))].map((m) => m[1] as string)

const BOTH_ARMS = migration('055_search_stop_suppressing_the_fallback.sql')
const [q055, precise055, floor055] = blocks(BOTH_ARMS, 'old')
const [qNew055, preciseNew055] = blocks(BOTH_ARMS, 'new')

const AFTER_055 = asInstalledBy048(migration('038_check_scopes_knowledge.sql'))
  .replace(q055!, qNew055!)
  .replace(precise055!, preciseNew055!)
  .replace(floor055!, '')

const HYGIENE = migration('064_knowledge_hygiene.sql')
const olds = blocks(HYGIENE, 'old')
const news = blocks(HYGIENE, 'new')

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
const REWRITTEN = olds.reduce((sql, from, i) => sql.split(from).join(news[i]!), AFTER_055)

describe('064 edits the search_all that is installed', () => {
  it('transforms rather than re-copying a body', () => {
    expect(HYGIENE).toContain('pg_get_functiondef')
    expect(HYGIENE).not.toContain('create or replace function search_all')
  })

  it('has two anchors, each in an arm\'s select list and its order by', () => {
    expect(olds).toHaveLength(2)
    expect(news).toHaveLength(2)
    for (const from of olds) expect(occurrences(AFTER_055, from), from).toBe(2)
  })

  it('leaves no unnormalised rank behind', () => {
    expect(REWRITTEN).not.toMatch(/ts_rank\(c\.vec, (?:coalesce\(q\.wide, q\.precise\)|q\.wide)\)/)
    expect(occurrences(REWRITTEN, ', 1|32)')).toBe(4)
  })

  it('normalises both arms the same way, so the merge stays one ordering', () => {
    expect(REWRITTEN).toContain('ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32) as rank')
    expect(REWRITTEN).toContain('ts_rank(c.vec, q.wide, 1|32) as rank')
  })

  it('costs nothing 055, 038, 033 or 048 installed', () => {
    expect(REWRITTEN).toContain('055: both arms run')
    expect(REWRITTEN).toContain('>= q.threshold')
    expect(REWRITTEN).toContain('join project_entities ep on ep.entity_id = ke.entity_id')
    expect(REWRITTEN).toContain("case when hits.status = 'superseded' then 0.4 else 1 end")
    expect(REWRITTEN).not.toContain('owner_user_id = p_owner')
  })

  it('checks the same things in the database, and is rerunnable', () => {
    expect(HYGIENE).toContain("raise exception 'search_all: the rewrite lost behaviour an earlier migration installed'")
    expect(HYGIENE).toContain("raise notice 'search_all already normalises rank by length")
  })
})

describe('064 replaces the recall functions from their live definitions', () => {
  it('only adds the sweep test to knowledge_recall_counts (061)', () => {
    const body = (sql: string) =>
      sql.slice(sql.indexOf('create or replace function knowledge_recall_counts'), sql.indexOf('$$;', sql.indexOf('create or replace function knowledge_recall_counts')))
    const before = body(migration('061_knowledge_recall_counts.sql'))
    const after = body(HYGIENE)
    expect(after.replace('where r.hit and not r.sweep and', 'where r.hit and')).toBe(before)
  })

  it('only adds the sweep test to the read trigger (062)', () => {
    const fn = (sql: string) => {
      const start = sql.indexOf('create or replace function knowledge_touch_recalled_from_read')
      return sql.slice(start, sql.indexOf('$$;', start))
    }
    expect(fn(HYGIENE).replace('if new.hit and not new.sweep then', 'if new.hit then')).toBe(
      fn(migration('062_knowledge_last_recalled.sql')),
    )
  })
})
