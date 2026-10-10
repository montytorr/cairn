/**
 * The Cairn side: what the target already holds, and the writer.
 *
 * The writer is the same code on a dry run and on --apply. A dry run runs it
 * and rolls back, so it is checked against the real constraints and triggers
 * of the target, not against this file's idea of them. Only the attachment
 * files are different: a dry run reads them, a real run copies them.
 */
import { copyFiles, removeFiles } from './files.mjs'

/** The advisory lock scripts/migrate.mjs takes, so an import never interleaves with a migration. */
const MIGRATION_LOCK = 7_261_693

const LAB_TABLES = [
  'lab_settings',
  'lab_stages',
  'lab_tags',
  'subjects',
  'subject_tags',
  'subject_notes',
  'subject_human_notes',
  'subject_attachments',
  'subject_number_counter',
]

/** Columns the target must have, beyond the tables above. */
const LAB_COLUMNS = {
  tasks: ['subject_id', 'handoff_tracker', 'handoff_ref', 'handoff_url', 'handoff_status', 'handoff_synced_at'],
  projects: ['handoff_tracker', 'handoff_target'],
  task_activity_events: ['subject_id'],
}

const ident = (name) => `"${name.replace(/"/g, '""')}"`
const BATCH = 250

const q = async (client, sql, params = []) => (await client.query(sql, params)).rows

export const readTarget = async (client) => {
  const problems = []
  const columns = new Map()
  for (const row of await q(
    client,
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Set())
    columns.get(row.table_name).add(row.column_name)
  }

  const missingTables = LAB_TABLES.filter((t) => !columns.has(t))
  if (missingTables.length) {
    problems.push(
      `the target is not migrated to the Lab: no table ${missingTables.join(', ')}. Run the migrations (npm run db:migrate) first.`,
    )
  }
  for (const [table, wanted] of Object.entries(LAB_COLUMNS)) {
    const have = columns.get(table)
    const missing = have ? wanted.filter((c) => !have.has(c)) : wanted
    if (missing.length) problems.push(`the target's ${table} has no column ${missing.join(', ')}: run the migrations first`)
  }
  for (const table of ['app_users', 'user_profiles', 'projects', 'tasks', 'task_notes', 'task_comments', 'task_attachments']) {
    if (!columns.has(table)) problems.push(`the target has no table ${table}: is it a Cairn database?`)
  }
  if (problems.length) return { problems, columns }

  const subjectCount = (await q(client, `select count(*)::int as n from subjects`))[0].n
  const settings = (await q(client, `select * from lab_settings limit 1`))[0] ?? null
  const formerKeys = columns.has('project_former_keys')
    ? (await q(client, `select key from project_former_keys`)).map((r) => r.key)
    : []

  // The event kinds the target's CHECK accepts. Read from the constraint, so
  // an event kind the Lab adds is imported and one Croft invented is reported.
  let eventKinds = null
  for (const row of await q(
    client,
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.task_activity_events'::regclass and contype = 'c'`,
  )) {
    if (!/\bevent\b/.test(row.def) || !/ARRAY\[/.test(row.def)) continue
    eventKinds = new Set([...row.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))
  }

  return {
    problems,
    columns,
    subjectCount,
    settings,
    formerKeys,
    eventKinds,
    counter: columns.get('subject_number_counter')?.has('last_number')
      ? ((await q(client, `select last_number from subject_number_counter limit 1`))[0]?.last_number ?? 0)
      : null,
    users: await q(client, `select id, email, role from app_users`),
    stages: await q(client, `select id, name, category, color, position from lab_stages`),
    tags: await q(client, `select id, name from lab_tags`),
    projects: await q(client, `select id, key, task_counter from projects`),
  }
}

const insertRows = async (client, columns, table, rows, { skipExisting = false } = {}) => {
  if (!rows.length) return 0
  const have = columns.get(table)
  const keys = Object.keys(rows[0])
  const usable = keys.filter((k) => have.has(k))
  for (const key of keys.filter((k) => !have.has(k))) {
    if (rows.some((r) => r[key] !== null && r[key] !== undefined)) {
      throw new Error(`the target's ${table} has no column ${key}, and the import has values for it`)
    }
  }
  const list = usable.map(ident).join(', ')
  for (let i = 0; i < rows.length; i += BATCH) {
    await client.query(
      `insert into public.${ident(table)} (${list})
       select ${list} from jsonb_populate_recordset(null::public.${ident(table)}, $1::jsonb)
       ${skipExisting ? 'on conflict do nothing' : ''}`,
      [JSON.stringify(rows.slice(i, i + BATCH))],
    )
  }
  return rows.length
}

const touchTrigger = async (client, table) => {
  const rows = await q(
    client,
    `select tgname from pg_trigger
      where tgrelid = $1::regclass and not tgisinternal and tgname = $2`,
    [`public.${table}`, `${table}_touch`],
  )
  return rows[0]?.tgname ?? null
}

/**
 * Writes the plan. The caller owns the transaction (begin before, commit or
 * rollback after) and passes `apply` only to say whether files are copied.
 * Returns the verification and the files written.
 */
export const writePlan = async ({ client, plan, target, apply, stores, log = () => {} }) => {
  const { rows } = plan
  const columns = target.columns
  const written = []
  const say = (message) => log(message)

  await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])

  say('users')
  await insertRows(client, columns, 'app_users', rows.app_users)
  // A profile the target already has (a reused user's) is theirs.
  await insertRows(client, columns, 'user_profiles', rows.user_profiles, { skipExisting: true })

  say('stages and tags')
  for (const s of rows.lab_stages.update) {
    await client.query(`update lab_stages set category = $2, color = $3, position = $4 where id = $1`, [
      s.id,
      s.category,
      s.color,
      s.position,
    ])
  }
  await insertRows(client, columns, 'lab_stages', rows.lab_stages.insert)
  await insertRows(client, columns, 'lab_tags', rows.lab_tags)

  say('projects')
  await insertRows(client, columns, 'projects', rows.projects)
  if (rows.home.existing) {
    await client.query(`update projects set task_counter = $2 where id = $1`, [rows.home.id, rows.home.existing.task_counter])
  }
  const settings = rows.lab_settings
  await client.query(
    `insert into lab_settings (id, enabled, home_project_id, updated_by)
     values (true, $1, $2, $3)
     on conflict (id) do update
       set enabled = excluded.enabled,
           home_project_id = coalesce(excluded.home_project_id, lab_settings.home_project_id),
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [settings.enabled, settings.home_project_id, settings.updated_by],
  )

  say('subjects')
  await insertRows(client, columns, 'subjects', rows.subjects)
  await insertRows(client, columns, 'subject_tags', rows.subject_tags)
  await insertRows(client, columns, 'subject_notes', rows.subject_notes)
  await insertRows(client, columns, 'subject_human_notes', rows.subject_human_notes)

  const subjectFiles = plan.files.filter((f) => f.kind === 'subject')
  const taskFiles = plan.files.filter((f) => f.kind === 'task')
  const copy = async (files) => {
    if (!files.length || !apply) return
    written.push(...(await copyFiles({ source: stores.source, target: stores.target, files })))
  }

  try {
    await copy(subjectFiles)
    await insertRows(client, columns, 'subject_attachments', rows.subject_attachments)

    say('todos')
    await insertRows(client, columns, 'tasks', rows.tasks)
    await insertRows(client, columns, 'task_notes', rows.task_notes)
    await insertRows(client, columns, 'task_comments', rows.task_comments)
    await copy(taskFiles)
    await insertRows(client, columns, 'task_attachments', rows.task_attachments)
    await insertRows(client, columns, 'task_activity_events', rows.task_activity_events)

    say('counters and timestamps')
    if (columns.get('subject_number_counter')?.has('last_number')) {
      await client.query(`update subject_number_counter set last_number = greatest(last_number, $1)`, [plan.counterAfter])
    }

    // tasks.assignee_user_id is a deferred foreign key. ALTER TABLE refuses a
    // table with pending trigger events, so settle them first: it also means
    // a bad assignee fails here and not at commit.
    await client.query('set constraints all immediate')

    // The triggers that touch a subject or a task on every child insert have
    // run by now. Put back the times the rows had, with the touch trigger off.
    for (const [table, list] of [
      ['subjects', rows.subjects],
      ['tasks', rows.tasks],
    ]) {
      const trigger = await touchTrigger(client, table)
      if (trigger) await client.query(`alter table public.${ident(table)} disable trigger ${ident(trigger)}`)
      try {
        for (let i = 0; i < list.length; i += 1000) {
          const part = list.slice(i, i + 1000)
          await client.query(
            `update public.${ident(table)} t set updated_at = u.ts
               from unnest($1::uuid[], $2::timestamptz[]) as u(id, ts)
              where t.id = u.id`,
            [part.map((r) => r.id), part.map((r) => r.updated_at)],
          )
        }
      } finally {
        if (trigger) await client.query(`alter table public.${ident(table)} enable trigger ${ident(trigger)}`)
      }
    }

    const verification = await verify({ client, plan })
    return { verification, written }
  } catch (error) {
    if (stores?.target) await removeFiles({ target: stores.target, paths: written })
    throw error
  }
}

const verify = async ({ client, plan }) => {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0]

  const ids = (list) => list.map((r) => r.id)
  const countIn = async (table, list) =>
    (await one(`select count(*)::int as n from public.${ident(table)} where id = any($1::uuid[])`, [ids(list)])).n
  for (const table of [
    'subjects',
    'subject_notes',
    'subject_human_notes',
    'subject_attachments',
    'tasks',
    'task_notes',
    'task_comments',
    'task_attachments',
    'task_activity_events',
  ]) {
    const expected = plan.rows[table].length
    const found = await countIn(table, plan.rows[table])
    check(`${table} rows`, found === expected, `${found} of ${expected}`)
  }

  const numbers = (
    await client.query(`select number from subjects where id = any($1::uuid[]) order by number`, [ids(plan.rows.subjects)])
  ).rows.map((r) => r.number)
  const wanted = plan.rows.subjects.map((s) => s.number).sort((a, b) => a - b)
  check('subject numbers kept', numbers.length === wanted.length && numbers.every((n, i) => n === wanted[i]), `${numbers.length} numbers`)

  const times = await one(
    `select count(*)::int as n from subjects s
       join jsonb_to_recordset($1::jsonb) as p(id uuid, updated_at timestamptz) on p.id = s.id
      where s.updated_at is distinct from p.updated_at`,
    [JSON.stringify(plan.rows.subjects.map((s) => ({ id: s.id, updated_at: s.updated_at })))],
  )
  check('subject updated_at kept', times.n === 0, `${times.n} moved`)

  const counter = (await client.query(`select last_number from subject_number_counter limit 1`)).rows[0]
  if (counter) {
    check('subject counter past the highest', counter.last_number >= plan.counterAfter, `${counter.last_number} >= ${plan.counterAfter}`)
  }

  const taskNumbers = await client.query(
    `select p.key, p.task_counter, max(t.number)::int as highest
       from tasks t join projects p on p.id = t.project_id
      where t.id = any($1::uuid[]) group by p.key, p.task_counter`,
    [ids(plan.rows.tasks)],
  )
  const behind = taskNumbers.rows.filter((r) => r.task_counter < r.highest)
  check('project task counters', behind.length === 0, behind.length ? behind.map((r) => r.key).join(', ') : `${taskNumbers.rowCount} project(s)`)

  const claimed = await one(`select count(*)::int as n from tasks where id = any($1::uuid[]) and claimed_by is not null`, [
    ids(plan.rows.tasks),
  ])
  check('no claims', claimed.n === 0, `${claimed.n} claimed`)

  const settings = (await client.query(`select enabled, home_project_id from lab_settings limit 1`)).rows[0]
  check(
    'lab switched',
    plan.options.enableLab === false ? true : settings?.enabled === true,
    `enabled=${settings?.enabled}`,
  )
  return checks
}
