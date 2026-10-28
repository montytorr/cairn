/**
 * What a database's schema says, read from the catalog: the columns a copy can
 * write, which of them name a user, and whether two databases agree.
 */

export const ident = (name) => `"${name.replace(/"/g, '""')}"`

const q = async (client, sql, params = []) => (await client.query(sql, params)).rows

/** Every table the move reads or writes, in the order they are copied. */
export const TABLES = [
  'entities',
  'projects',
  'project_former_keys',
  'project_repos',
  'project_entities',
  'tasks',
  'task_projects',
  'task_former_refs',
  'task_deps',
  'task_notes',
  'task_comments',
  'task_attachments',
  'task_activity_events',
  'sessions',
  'file_touches',
  'knowledge',
  'knowledge_projects',
  'knowledge_entities',
  'knowledge_files',
  'knowledge_revisions',
  'knowledge_recall_state',
  'knowledge_reads',
]

/** Tables the move never copies, and why. Counted only. */
export const LEFT_ALONE = [
  ['app_users', 'people are matched by email; accounts are not copied'],
  ['api_keys', 'agent keys belong to an instance'],
  ['app_sessions', 'sign-ins belong to an instance'],
  ['search_events', 'search telemetry stays where it was searched'],
  ['task_mentions', 'derived from the text: rebuilt on the target'],
  ['subject_mentions', 'derived from the text: rebuilt on the target'],
]

/**
 * @returns {Promise<{ columns: Map<string, string[]>, userColumns: Map<string, string[]>,
 *   migrations: string[], problems: string[] }>}
 */
export const readCatalog = async (client) => {
  const columns = new Map()
  for (const row of await q(
    client,
    `select c.relname as table, a.attname as column
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0
        and not a.attisdropped and a.attgenerated = ''
      order by c.relname, a.attnum`,
  )) {
    if (!columns.has(row.table)) columns.set(row.table, [])
    columns.get(row.table).push(row.column)
  }
  const userColumns = new Map()
  for (const row of await q(
    client,
    `select c.conrelid::regclass::text as table, a.attname as column
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'public.app_users'::regclass
        and c.connamespace = 'public'::regnamespace`,
  )) {
    const table = row.table.replace(/^public\./, '')
    if (!userColumns.has(table)) userColumns.set(table, [])
    userColumns.get(table).push(row.column)
  }
  const problems = []
  for (const t of TABLES) if (!columns.has(t)) problems.push(`no table ${t}: is this a Cairn database at 078?`)
  const migrations = columns.has('_cairn_migrations')
    ? (await q(client, `select name from _cairn_migrations order by name`)).map((r) => r.name)
    : []
  return { columns, userColumns, migrations, problems }
}

/** Both sides must be the same schema, or a copy by column name would be a guess. */
export const compareCatalogs = (a, b) => {
  const problems = []
  const la = a.migrations.at(-1)
  const lb = b.migrations.at(-1)
  if (la !== lb) problems.push(`the source is at migration ${la ?? 'none'} and the target at ${lb ?? 'none'}: run the same release on both`)
  for (const t of TABLES) {
    const x = [...(a.columns.get(t) ?? [])].sort().join(',')
    const y = [...(b.columns.get(t) ?? [])].sort().join(',')
    if (x !== y) problems.push(`${t} has different columns on the two sides`)
  }
  return problems
}
