import { randomUUID } from 'node:crypto'
import { hash } from 'bcryptjs'
import { Client } from 'pg'

const main = async () => {
  const url = process.env.DATABASE_URL
  const email = process.env.CAIRN_OPERATOR_EMAIL?.trim()
  const password = process.env.CAIRN_OPERATOR_PASSWORD
  const displayName = process.env.CAIRN_OPERATOR_NAME?.trim() || null
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (!email || !email.includes('@')) throw new Error('CAIRN_OPERATOR_EMAIL is required.')
  if (!password || password.length < 12) {
    throw new Error('CAIRN_OPERATOR_PASSWORD must be at least 12 characters.')
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('begin')
    const existing = await client.query<{ id: string }>(
      'select id from app_users where lower(email) = lower($1)',
      [email],
    )
    const id = existing.rows[0]?.id || randomUUID()
    const encrypted = await hash(password, 12)
    if (existing.rows[0]) {
      await client.query(
        `update app_users set email = $1, encrypted_password = $2,
         banned_until = null, deleted_at = null, updated_at = now() where id = $3`,
        [email, encrypted, id],
      )
    } else {
      await client.query(
        'insert into app_users (id, email, encrypted_password) values ($1, $2, $3)',
        [id, email, encrypted],
      )
    }
    await client.query(
      `insert into user_profiles (id, display_name) values ($1, $2)
       on conflict (id) do update set display_name = excluded.display_name`,
      [id, displayName],
    )
    await client.query('commit')
    console.log(`operator ready: ${email}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
