/**
 * Applies supabase/migrations/*.sql in filename order, inside a transaction,
 * recording what has run in a `_cairn_migrations` table.
 *
 * Deliberately plain: numbered SQL files are easier to reason about than a
 * generated migration chain, and they are what the self-hosting instructions
 * tell people to run.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

const main = async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. See .env.example.')
    process.exit(1)
  }

  const client = new Client({ connectionString: url })
  await client.connect()

  await client.query(`
    create table if not exists _cairn_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const { rows } = await client.query<{ name: string }>('select name from _cairn_migrations')
  const applied = new Set(rows.map((r) => r.name))

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  let ran = 0
  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    console.log(`applying ${file}`)

    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into _cairn_migrations (name) values ($1)', [file])
      await client.query('commit')
      ran += 1
    } catch (error) {
      await client.query('rollback')
      console.error(`failed on ${file}:`, error instanceof Error ? error.message : error)
      await client.end()
      process.exit(1)
    }
  }

  await client.end()
  console.log(ran === 0 ? 'nothing to apply' : `applied ${ran} migration(s)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
