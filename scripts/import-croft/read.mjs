/**
 * The Croft side: everything the importer needs, read once into plain arrays.
 *
 * Read-only by construction: the transaction is `read only`, so a bug here
 * cannot change the database it is reading.
 *
 * Timestamps and dates come back as the text Postgres sent, never as a Date.
 * A JavaScript Date holds milliseconds and Postgres holds microseconds, so a
 * round trip through one would quietly move every created_at.
 */
import pg from 'pg'

const RAW_TYPES = new Set([
  1082, // date
  1114, // timestamp
  1184, // timestamptz
])

export const rawTypes = {
  getTypeParser: (oid, format) =>
    RAW_TYPES.has(oid) ? (value) => value : pg.types.getTypeParser(oid, format),
}

/** Columns the importer cannot do without, by table. */
const REQUIRED = {
  app_users: ['id', 'email', 'encrypted_password', 'role'],
  user_profiles: ['id', 'display_name'],
  subject_stages: ['id', 'name', 'category', 'color', 'position'],
  tags: ['id', 'name', 'color', 'position'],
  lab_projects: ['id', 'name', 'color', 'position', 'handoff_tracker', 'handoff_target'],
  subjects: ['id', 'number', 'title', 'stage_id', 'visibility', 'project_id'],
  subject_notes: ['id', 'subject_id', 'kind', 'note', 'content_hash'],
  subject_human_notes: ['id', 'subject_id', 'body'],
  subject_attachments: ['id', 'subject_id', 'storage_path'],
  subject_number_counter: ['last_number'],
  projects: ['id', 'key'],
  tasks: ['id', 'project_id', 'number', 'handoff_tracker', 'handoff_ref', 'subject_id'],
  task_notes: ['id', 'task_id'],
  task_comments: ['id', 'task_id'],
  task_activity_events: ['id', 'event'],
  task_attachments: ['id', 'task_id', 'storage_path'],
}

/** Tables the importer deliberately leaves behind, counted so the report can say so. */
const LEFT_BEHIND = [
  ['api_keys', 'agent keys are not copied: people pair again'],
  ['app_sessions', 'sessions are not copied: people sign in again'],
  ['password_reset_tokens', 'reset tokens are short-lived and not copied'],
  ['connect_requests', 'pairing requests are short-lived and not copied'],
  ['subject_members', 'there is no row-level visibility in the Lab: every subject is visible to every user'],
]

const all = async (client, sql, params = []) => (await client.query(sql, params)).rows

const tableExists = async (client, name) =>
  (await client.query(`select to_regclass($1) is not null as present`, [`public.${name}`])).rows[0].present

export const croftProblems = async (client) => {
  const problems = []
  const { rows } = await client.query(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )
  const have = new Map()
  for (const row of rows) {
    if (!have.has(row.table_name)) have.set(row.table_name, new Set())
    have.get(row.table_name).add(row.column_name)
  }
  for (const [table, columns] of Object.entries(REQUIRED)) {
    const present = have.get(table)
    if (!present) {
      problems.push(`the Croft database has no table ${table}: is it a Croft database, migrated to 081?`)
      continue
    }
    const missing = columns.filter((c) => !present.has(c))
    if (missing.length) {
      problems.push(`Croft table ${table} has no column ${missing.join(', ')}: migrate Croft to 081 first`)
    }
  }
  return problems
}

export const readCroft = async (client) => {
  await client.query('begin transaction isolation level repeatable read read only')
  try {
    const problems = await croftProblems(client)
    if (problems.length) return { problems }

    const migrations = (await tableExists(client, '_cairn_migrations'))
      ? (await all(client, `select name from _cairn_migrations order by name`)).map((r) => r.name)
      : []

    const leftBehind = []
    for (const [table, why] of LEFT_BEHIND) {
      if (!(await tableExists(client, table))) continue
      const { rows } = await client.query(`select count(*)::int as n from ${table}`)
      leftBehind.push({ table, count: rows[0].n, why })
    }

    const snapshot = {
      problems: [],
      migrations,
      users: await all(client, `select * from app_users order by created_at, email`),
      profiles: await all(client, `select * from user_profiles`),
      stages: await all(client, `select * from subject_stages order by position, created_at`),
      tags: await all(client, `select * from tags order by position, name`),
      labProjects: await all(client, `select * from lab_projects order by position, created_at`),
      subjects: await all(client, `select * from subjects order by number`),
      subjectTags: await all(client, `select * from subject_tags`),
      subjectNotes: await all(client, `select * from subject_notes order by created_at, id`),
      subjectHumanNotes: await all(client, `select * from subject_human_notes order by created_at, id`),
      subjectAttachments: await all(client, `select * from subject_attachments order by created_at, id`),
      counter: (await all(client, `select last_number from subject_number_counter`))[0]?.last_number ?? 0,
      projects: await all(client, `select * from projects order by key`),
      tasks: await all(client, `select * from tasks order by project_id, number`),
      taskNotes: await all(client, `select * from task_notes order by created_at, id`),
      taskComments: await all(client, `select * from task_comments order by created_at, id`),
      taskEvents: await all(client, `select * from task_activity_events order by created_at, id`),
      taskAttachments: await all(client, `select * from task_attachments order by created_at, id`),
      leftBehind,
    }
    return snapshot
  } finally {
    await client.query('rollback')
  }
}
