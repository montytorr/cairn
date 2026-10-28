/**
 * The move itself: reads both instances, writes the target, then empties the
 * source, inside one transaction on each. The caller commits or rolls back.
 *
 * Rows are copied as JSON text from source to target, never through a
 * JavaScript object, so timestamps keep their microseconds and bigints their
 * digits. Every column is copied by name from the catalog; only the columns
 * that point across the move are changed on the way (users, references to
 * rows that stay behind).
 */
import { ident, LEFT_ALONE, TABLES } from './catalog.mjs'
import {
  findMirrors,
  matchUsers,
  moveUrl,
  planCollisions,
  refKeys,
  refMap,
  rewriteField,
  summariseRewrites,
  tempKey,
  trimBase,
} from './plan.mjs'

/** The advisory lock scripts/migrate.mjs takes, so a move never interleaves with a migration. */
export const MIGRATION_LOCK = 7_261_693
const BATCH = 500

const q = async (client, sql, params = []) => (await client.query(sql, params)).rows
const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0]
const n = async (client, sql, params = []) => Number((await one(client, sql, params)).n)

/** Triggers the copy switches off on the target, because it writes what they would derive. */
const TARGET_TRIGGERS = [
  ['tasks', 'task_mentions_task'],
  ['task_notes', 'task_mentions_note'],
  ['task_notes', 'task_notes_touch_task'],
  ['task_comments', 'task_mentions_comment'],
  ['task_comments', 'task_comments_reindex'],
  ['task_attachments', 'task_attachments_touch_task'],
  ['knowledge', 'knowledge_files_sync'],
  ['knowledge_reads', 'knowledge_reads_tag_sweep'],
  ['knowledge_reads', 'knowledge_touch_recalled'],
]
/** On the source, only the ones a cascade would fire once per deleted row for nothing. */
const SOURCE_TRIGGERS = [
  ['task_notes', 'task_notes_touch_task'],
  ['task_comments', 'task_comments_reindex'],
  ['task_attachments', 'task_attachments_touch_task'],
]

const setTriggers = async (client, list, on) => {
  for (const [table, trigger] of list) {
    await client.query(`alter table public.${ident(table)} ${on ? 'enable' : 'disable'} trigger ${ident(trigger)}`)
  }
}

export const disabledTriggers = async (client) =>
  (
    await q(
      client,
      `select c.relname || '.' || t.tgname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace s on s.oid = c.relnamespace
        where s.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'D' order by 1`,
    )
  ).map((r) => r.name)

/**
 * The sets that decide what moves, as temp tables on the source. Everything
 * below selects through them, so "what moves" is written down once.
 */
const SOURCE_SETS = `
  create temp table mv_projects on commit drop as
    select id, key from projects where id = any($1::uuid[]);
  alter table mv_projects add primary key (id);
  create temp table mv_tasks on commit drop as
    select t.id, t.project_id, t.number from tasks t where t.project_id in (select id from mv_projects);
  alter table mv_tasks add primary key (id);
  create temp table mv_sessions on commit drop as
    select id from sessions where project_id in (select id from mv_projects);
  alter table mv_sessions add primary key (id);
  create temp table kn_scope on commit drop as
    select k.id, k.slug,
           case when count(kp.project_id) = 0 then 'global'
                when bool_and(kp.project_id in (select id from mv_projects)) then 'move'
                when bool_or(kp.project_id in (select id from mv_projects)) then 'copy'
                else 'stay' end as scope
      from knowledge k left join knowledge_projects kp on kp.knowledge_id = k.id
     group by k.id, k.slug;
  create temp table mv_knowledge on commit drop as select id, slug, scope from kn_scope where scope in ('move', 'copy');
  alter table mv_knowledge add primary key (id);
`

/** What moves in each table, on the source (alias t). */
const MOVES = {
  projects: 't.id in (select id from mv_projects)',
  project_former_keys: 't.project_id in (select id from mv_projects)',
  project_repos: 't.project_id in (select id from mv_projects)',
  project_entities: 't.project_id in (select id from mv_projects)',
  tasks: 't.id in (select id from mv_tasks)',
  task_projects: 't.task_id in (select id from mv_tasks)',
  task_former_refs: 't.task_id in (select id from mv_tasks)',
  task_deps: 't.blocked_id in (select id from mv_tasks) or t.blocking_id in (select id from mv_tasks)',
  task_notes: 't.task_id in (select id from mv_tasks)',
  task_comments: 't.task_id in (select id from mv_tasks)',
  task_attachments: 't.task_id in (select id from mv_tasks)',
  task_activity_events:
    't.task_id in (select id from mv_tasks) or (t.task_id is null and t.project_id in (select id from mv_projects))',
  sessions: 't.id in (select id from mv_sessions)',
  file_touches:
    't.task_id in (select id from mv_tasks) or (t.task_id is null and t.session_id in (select id from mv_sessions))',
  knowledge: 't.id in (select id from mv_knowledge)',
  knowledge_projects: 't.knowledge_id in (select id from mv_knowledge)',
  knowledge_entities: 't.knowledge_id in (select id from mv_knowledge)',
  knowledge_files: 't.knowledge_id in (select id from mv_knowledge)',
  knowledge_revisions: 't.knowledge_id in (select id from mv_knowledge)',
  knowledge_recall_state: 't.knowledge_id in (select id from mv_knowledge)',
  knowledge_reads: 't.slug in (select slug from mv_knowledge)',
}

/** Of the rows that move, the ones the target cannot hold (they name something that stays). */
const DROPPED = {
  task_projects: 't.project_id not in (select id from mv_projects)',
  task_former_refs: 't.project_id not in (select id from mv_projects)',
  task_deps: 'not (t.blocked_id in (select id from mv_tasks) and t.blocking_id in (select id from mv_tasks))',
  knowledge_projects: 't.project_id not in (select id from mv_projects)',
}

/** The entities the moving rows link to, on the source. */
const MOVING_ENTITIES = `t.id in (
  select entity_id from project_entities where project_id in (select id from mv_projects)
  union select entity_id from knowledge_entities where knowledge_id in (select id from mv_knowledge))`

const ORDER = {
  project_former_keys: 't.key',
  project_repos: 't.project_id, t.remote',
  project_entities: 't.project_id, t.entity_id',
  task_projects: 't.task_id, t.project_id',
  task_former_refs: 't.project_id, t.number',
  task_deps: 't.blocked_id, t.blocking_id',
  knowledge_projects: 't.knowledge_id, t.project_id',
  knowledge_entities: 't.knowledge_id, t.entity_id',
  knowledge_files: 't.knowledge_id, t.path, t.origin',
  knowledge_recall_state: 't.knowledge_id',
}

/** Column rewrites on the target side (alias r), on top of the user mapping. */
const TARGET_EXPR = {
  project_entities: { entity_id: '(select dst from mv_entities where src = r.entity_id)' },
  tasks: { parent_id: 'null', duplicate_of: 'null' },
  task_activity_events: { project_id: 'case when r.project_id in (select id from mv_projects) then r.project_id end' },
  file_touches: {
    session_id: '(select dst from mv_sessions where src = r.session_id)',
    project_id: 'case when r.project_id in (select id from mv_projects) then r.project_id end',
    knowledge_id: 'case when r.knowledge_id in (select id from mv_knowledge) then r.knowledge_id end',
  },
  knowledge: {
    superseded_by: 'null',
    source_task_id: 'case when r.source_task_id in (select id from mv_tasks) then r.source_task_id end',
    source_session_id: '(select dst from mv_sessions where src = r.source_session_id)',
  },
  knowledge_entities: { entity_id: '(select dst from mv_entities where src = r.entity_id)' },
  knowledge_revisions: {
    superseded_by: 'case when r.superseded_by in (select id from mv_knowledge) then r.superseded_by end',
  },
}

/** Column rewrites on the source side (alias t), where the source knows something the target does not. */
const SOURCE_EXPR = {
  knowledge: {
    // A session that stays behind is still named, the way a session that was never recorded is.
    source_session_ref: `coalesce(t.source_session_ref,
       (select s.external_id from sessions s where s.id = t.source_session_id and s.id not in (select id from mv_sessions)))`,
  },
}

const sourceRows = async function* (client, table, columns, where) {
  const select = columns
    .map((c) => (SOURCE_EXPR[table]?.[c] ? `${SOURCE_EXPR[table][c]} as ${ident(c)}` : `t.${ident(c)}`))
    .join(', ')
  const order = ORDER[table] ?? 't.id'
  for (let offset = 0; ; offset += BATCH) {
    const row = await one(
      client,
      `select count(*)::int as n, coalesce(json_agg(x), '[]')::text as rows
         from (select ${select} from public.${ident(table)} t where (${where}) order by ${order}
               limit ${BATCH} offset ${offset}) x`,
    )
    if (row.n === 0) return
    yield row
    if (row.n < BATCH) return
  }
}

const copyTable = async ({ source, target, table, catalog, where, extraTarget = {} }) => {
  const columns = catalog.columns.get(table)
  const exprs = { ...(TARGET_EXPR[table] ?? {}), ...extraTarget }
  for (const c of catalog.userColumns.get(table) ?? []) exprs[c] ??= `(select dst from mv_users where src = r.${ident(c)})`
  const insert = `insert into public.${ident(table)} (${columns.map(ident).join(', ')})
    select ${columns.map((c) => exprs[c] ?? `r.${ident(c)}`).join(', ')}
      from json_populate_recordset(null::public.${ident(table)}, $1::json) r`
  let read = 0
  let written = 0
  for await (const batch of sourceRows(source, table, columns, where)) {
    read += batch.n
    written += (await target.query(insert, [batch.rows])).rowCount
  }
  return { read, written }
}

const fill = async (client, table, columns, rows) => {
  for (let i = 0; i < rows.length; i += 5000) {
    const part = rows.slice(i, i + 5000)
    await client.query(
      `insert into ${table} (${columns.join(', ')}) select * from unnest(${columns.map((_, k) => `$${k + 1}::uuid[]`).join(', ')})`,
      columns.map((c) => part.map((r) => r[c])),
    )
  }
}

const refOf = (key, number) => `${key}-${number}`

/**
 * Reads what the plan needs from both sides. The source sets (temp tables) are
 * created here, inside the caller's transaction.
 */
export const readFacts = async ({ source, target, movingIds, sourceBaseUrl }) => {
  // One statement at a time: a parameterised query cannot hold several.
  for (const statement of SOURCE_SETS.split(';').map((x) => x.trim()).filter(Boolean)) {
    await source.query(statement, statement.includes('$1') ? [movingIds] : [])
  }

  const sourceUsers = await q(source, `select id, lower(email) as email, deleted_at is not null as deleted from app_users`)
  const targetUsers = await q(target, `select id, lower(email) as email from app_users`)
  const movingProjects = await q(
    source,
    `select p.id, p.key, p.status, p.task_counter, p.external_ref from projects p
      where p.id in (select id from mv_projects) order by p.key`,
  )
  const sourceTasks = await q(
    source,
    `select x.id, x.project_id, x.number, p.key, x.external_ref, x.external_url, x.subject_id is not null as has_subject
       from tasks x join projects p on p.id = x.project_id where x.id in (select id from mv_tasks)`,
  )
  const formerKeys = await q(
    source,
    `select f.key, p.key as project_key from project_former_keys f join projects p on p.id = f.project_id
      where f.project_id in (select id from mv_projects)`,
  )

  const targetProjects = await q(
    target,
    `select id, key, status, task_counter, handoff_tracker, handoff_target, external_ref from projects order by key`,
  )
  const targetFormerKeys = await q(target, `select key, project_id from project_former_keys`)
  const targetTasks = await q(
    target,
    `select t.id, t.project_id, t.number, p.key || '-' || t.number as ref, t.handoff_tracker, t.handoff_ref,
            t.handoff_url, t.handoff_status, t.external_ref, t.subject_id, s.number as subject_number, t.status
       from tasks t join projects p on p.id = t.project_id left join subjects s on s.id = t.subject_id
      order by p.key, t.number`,
  )
  const labOn = (await one(target, `select coalesce((select enabled from lab_settings limit 1), false) as on`)).on

  const sourceTasksByRef = new Map(sourceTasks.map((t) => [refOf(t.key, t.number), t]))
  const movingKeys = movingProjects.map((p) => p.key)
  const mirrorPlan = findMirrors({ targetTasks, sourceBaseUrl, movingKeys, sourceTasksByRef })
  const collisionPlan = planCollisions({
    targetProjects,
    targetTasks,
    mirrors: mirrorPlan.mirrors,
    movingProjects,
    formerKeys,
  })

  return {
    sourceUsers,
    targetUsers,
    movingProjects,
    sourceTasks,
    formerKeys,
    targetProjects,
    targetFormerKeys,
    targetTasks,
    labOn,
    mirrors: mirrorPlan.mirrors,
    mirrorsUntouched: mirrorPlan.untouched,
    collisions: collisionPlan.collisions,
    errors: [...mirrorPlan.errors, ...collisionPlan.errors],
  }
}

/** How many moving rows name each of these source users, over every user column the copy writes. */
const usersReferenced = async (source, catalog, ids) => {
  const counts = new Map()
  if (!ids.length) return counts
  const where = { ...MOVES, entities: MOVING_ENTITIES }
  for (const table of TABLES) {
    for (const column of catalog.userColumns.get(table) ?? []) {
      for (const row of await q(
        source,
        `select t.${ident(column)} as id, count(*)::int as n from public.${ident(table)} t
          where (${where[table]}) and t.${ident(column)} = any($1::uuid[]) group by 1`,
        [ids],
      )) {
        counts.set(row.id, (counts.get(row.id) ?? 0) + row.n)
      }
    }
  }
  return counts
}

/** Problems that stop the move before anything is written. */
export const preflight = async ({ source, target, facts, catalog }) => {
  const errors = [...facts.errors]
  const warnings = []

  const targetEmails = new Set(facts.targetUsers.map((u) => u.email))
  const unmatched = facts.sourceUsers.filter((u) => !targetEmails.has(u.email)).map((u) => u.id)
  const matched = matchUsers({
    sourceUsers: facts.sourceUsers,
    targetUsers: facts.targetUsers,
    referenced: await usersReferenced(source, catalog, unmatched),
  })
  errors.push(...matched.errors)
  warnings.push(...matched.warnings)
  const { users } = matched

  const movingKeys = new Set(facts.movingProjects.map((p) => p.key))
  const collidingKeys = new Set(facts.collisions.map((c) => c.key))
  for (const f of facts.targetFormerKeys) {
    if (movingKeys.has(f.key)) errors.push(`${f.key} is a retired key on the target`)
  }
  for (const f of facts.formerKeys) {
    if (facts.targetFormerKeys.some((t) => t.key === f.key)) errors.push(`former key ${f.key} is also retired on the target`)
  }
  if (facts.sourceTasks.some((t) => t.has_subject)) errors.push('moving tasks are linked to subjects on the source: the source Lab is not empty')
  const sourceSubjects = await n(
    source,
    `select count(*) as n from task_activity_events t where t.subject_id is not null and (${MOVES.task_activity_events})`,
  )
  if (sourceSubjects) errors.push(`${sourceSubjects} moving event(s) name a subject on the source`)

  // Ids are uuids, so a clash means the target already holds these rows: a second run.
  const clash = await n(
    target,
    `select count(*) as n from projects where id = any($1::uuid[])`,
    [facts.movingProjects.map((p) => p.id)],
  )
  if (clash) errors.push(`the target already holds ${clash} of the moving projects (by id): has the move run already?`)
  const taskClash = await n(target, `select count(*) as n from tasks where id = any($1::uuid[])`, [facts.sourceTasks.map((t) => t.id)])
  if (taskClash) errors.push(`the target already holds ${taskClash} of the moving tasks (by id)`)

  // Unique values that would collide once both sides' rows share a table.
  const mirrorIds = new Set(facts.mirrors.map((m) => m.id))
  const targetRefs = new Map(
    facts.targetTasks.filter((t) => t.external_ref && !mirrorIds.has(t.id)).map((t) => [t.external_ref, t.ref]),
  )
  for (const t of facts.sourceTasks) {
    if (t.external_ref && targetRefs.has(t.external_ref)) {
      errors.push(`${refOf(t.key, t.number)} and the target's ${targetRefs.get(t.external_ref)} share external_ref ${t.external_ref}`)
    }
  }
  const projectRefs = new Set(facts.targetProjects.filter((p) => p.external_ref).map((p) => p.external_ref))
  for (const p of facts.movingProjects) {
    if (p.external_ref && projectRefs.has(p.external_ref)) errors.push(`${p.key}'s external_ref ${p.external_ref} is taken on the target`)
  }
  const slugs = (await q(source, `select slug from mv_knowledge`)).map((r) => r.slug)
  const slugClash = (await q(target, `select slug from knowledge where slug = any($1::text[]) order by slug`, [slugs])).map((r) => r.slug)
  for (const s of slugClash) errors.push(`knowledge ${s} exists on both sides`)
  const sessionKeys = await q(
    source,
    `select s.id, s.platform_source, s.external_id from sessions s where s.id in (select id from mv_sessions)`,
  )
  const sessionClash = await q(
    target,
    `select s.id, s.platform_source, s.external_id from sessions s
       join unnest($1::text[], $2::text[]) as k(p, e) on k.p = s.platform_source and k.e = s.external_id`,
    [sessionKeys.map((s) => s.platform_source), sessionKeys.map((s) => s.external_id)],
  )
  if (sessionClash.length) {
    warnings.push(`${sessionClash.length} moving session(s) are also recorded on the target: the target's row is kept and filled in`)
  }
  const commentRefs = await q(
    source,
    `select external_ref from task_comments where external_ref is not null and task_id in (select id from mv_tasks)`,
  )
  const commentClash = await n(target, `select count(*) as n from task_comments where external_ref = any($1::text[])`, [
    commentRefs.map((r) => r.external_ref),
  ])
  if (commentClash) errors.push(`${commentClash} comment external_ref(s) exist on both sides`)

  if (!facts.labOn && facts.mirrors.length) warnings.push('the target has mirrors but its Lab is off')
  for (const c of facts.collisions) {
    if (!collidingKeys.has(c.key)) continue
    const mirrored = facts.mirrors.filter((m) => m.project_id === c.id).length
    warnings.push(
      `${c.key} exists on the target: ${mirrored} mirror(s) merge into the real tasks, ${c.renumber.length} other task(s) are renumbered`,
    )
  }
  return { errors, warnings, users, sessionKeys, sessionClash }
}

/** Per moving project, how many rows of each kind go. */
export const countPerProject = async (source) =>
  q(
    source,
    `select p.key,
       (select count(*) from tasks t where t.project_id = p.id)::int as tasks,
       (select count(*) from task_notes x join tasks t on t.id = x.task_id where t.project_id = p.id)::int as notes,
       (select count(*) from task_comments x join tasks t on t.id = x.task_id where t.project_id = p.id)::int as comments,
       (select count(*) from task_attachments x join tasks t on t.id = x.task_id where t.project_id = p.id)::int as attachments,
       (select count(*) from task_activity_events x left join tasks t on t.id = x.task_id
         where t.project_id = p.id or (x.task_id is null and x.project_id = p.id))::int as events,
       (select count(*) from task_deps x join tasks t on t.id = x.blocked_id where t.project_id = p.id)::int as deps,
       (select count(*) from tasks t where t.project_id = p.id and t.parent_id is not null)::int as subtasks,
       (select count(*) from task_projects x join tasks t on t.id = x.task_id where t.project_id = p.id)::int as task_projects,
       (select count(*) from task_mentions x join tasks t on t.id = x.source_task_id where t.project_id = p.id)::int as mentions,
       (select count(*) from sessions s where s.project_id = p.id)::int as sessions,
       (select count(*) from file_touches f left join tasks t on t.id = f.task_id
         where t.project_id = p.id or (f.task_id is null and f.session_id in (select id from sessions s where s.project_id = p.id)))::int as file_touches,
       (select count(*) from knowledge_projects kp join kn_scope k on k.id = kp.knowledge_id
         where kp.project_id = p.id and k.scope = 'move')::int as knowledge_moved,
       (select count(*) from knowledge_projects kp join kn_scope k on k.id = kp.knowledge_id
         where kp.project_id = p.id and k.scope = 'copy')::int as knowledge_copied,
       (select count(*) from project_repos r where r.project_id = p.id)::int as repos,
       (select count(*) from project_former_keys f where f.project_id = p.id)::int as former_keys,
       (select count(*) from project_entities e where e.project_id = p.id)::int as entity_links,
       p.task_counter as counter, p.status
     from projects p where p.id in (select id from mv_projects) order by p.key`,
  )

/** Links that cross the line between what moves and what stays: they cannot survive on either side. */
export const crossingLinks = async (source) => {
  const ref = (alias) => `(select key from projects where id = ${alias}.project_id) || '-' || ${alias}.number`
  return {
    parents: await q(
      source,
      `select ${ref('c')} as child, ${ref('p')} as parent, c.id as child_id, c.project_id in (select id from mv_projects) as child_moves
         from tasks c join tasks p on p.id = c.parent_id
        where (c.project_id in (select id from mv_projects)) <> (p.project_id in (select id from mv_projects))`,
    ),
    duplicates: await q(
      source,
      `select ${ref('c')} as task, ${ref('p')} as duplicate_of, c.project_id in (select id from mv_projects) as task_moves
         from tasks c join tasks p on p.id = c.duplicate_of
        where (c.project_id in (select id from mv_projects)) <> (p.project_id in (select id from mv_projects))`,
    ),
    alsoIn: await q(
      source,
      `select ${ref('t')} as task, (select key from projects where id = x.project_id) as also, t.id as task_id,
              t.project_id in (select id from mv_projects) as task_moves
         from task_projects x join tasks t on t.id = x.task_id
        where (t.project_id in (select id from mv_projects)) <> (x.project_id in (select id from mv_projects))`,
    ),
    deps: await q(
      source,
      `select ${ref('a')} as blocked, ${ref('b')} as blocking
         from task_deps d join tasks a on a.id = d.blocked_id join tasks b on b.id = d.blocking_id
        where (a.project_id in (select id from mv_projects)) <> (b.project_id in (select id from mv_projects))`,
    ),
    mentions: await one(
      source,
      `select
         count(*) filter (where s.project_id not in (select id from mv_projects) and t.project_id in (select id from mv_projects))::int as stay_to_move,
         count(*) filter (where s.project_id in (select id from mv_projects) and t.project_id not in (select id from mv_projects))::int as move_to_stay,
         count(*) filter (where s.project_id in (select id from mv_projects) and t.project_id in (select id from mv_projects))::int as within
       from task_mentions m join tasks s on s.id = m.source_task_id join tasks t on t.id = m.target_task_id`,
    ),
    knowledgeSourcedFromMoving: await one(
      source,
      `select count(*) filter (where k.source_task_id in (select id from mv_tasks))::int as tasks,
              count(*) filter (where k.source_session_id in (select id from mv_sessions))::int as sessions
         from knowledge k join kn_scope s on s.id = k.id where s.scope in ('global', 'stay')`,
    ),
    supersededAcross: await q(
      source,
      `select k.slug, a.scope, s.slug as successor, b.scope as successor_scope
         from knowledge k join kn_scope a on a.id = k.id join knowledge s on s.id = k.superseded_by join kn_scope b on b.id = s.id
        where (a.scope in ('move', 'copy')) <> (b.scope in ('move', 'copy'))`,
    ),
    movedKnowledgeFromStayingSession: await n(
      source,
      `select count(*) as n from knowledge k where k.id in (select id from mv_knowledge)
          and k.source_session_id is not null and k.source_session_id not in (select id from mv_sessions)`,
    ),
  }
}

/** Counts that must not change on the side that keeps them. */
const stayingSnapshot = async (source) =>
  one(
    source,
    `select
       (select count(*) from tasks where id not in (select id from mv_tasks))::int as tasks,
       (select count(*) from task_notes where task_id not in (select id from mv_tasks))::int as task_notes,
       (select count(*) from task_comments where task_id not in (select id from mv_tasks))::int as task_comments,
       (select count(*) from task_attachments where task_id not in (select id from mv_tasks))::int as task_attachments,
       (select count(*) from task_activity_events
         where (task_id is not null and task_id not in (select id from mv_tasks))
            or (task_id is null and (project_id is null or project_id not in (select id from mv_projects))))::int as task_events,
       (select count(*) from projects where id not in (select id from mv_projects))::int as projects,
       (select count(*) from knowledge where id not in (select id from mv_knowledge where scope = 'move'))::int as knowledge,
       (select count(*) from sessions where id not in (select id from mv_sessions))::int as sessions,
       (select count(*) from knowledge_reads where slug not in (select slug from mv_knowledge where scope = 'move'))::int as knowledge_reads,
       (select count(*) from entities)::int as entities,
       (select coalesce(sum(task_counter), 0) from projects where id not in (select id from mv_projects))::int as counters`,
  )

const targetSnapshot = async (target) =>
  one(
    target,
    `select
       (select count(*) from subjects)::int as subjects,
       (select count(*) from subject_notes)::int as subject_notes,
       (select count(*) from subject_human_notes)::int as subject_human_notes,
       (select count(*) from subject_tags)::int as subject_tags,
       (select count(*) from tasks)::int as tasks,
       (select count(*) from task_notes)::int as task_notes,
       (select count(*) from task_comments)::int as task_comments,
       (select count(*) from task_activity_events)::int as task_activity_events,
       (select count(*) from projects)::int as projects,
       (select count(*) from knowledge)::int as knowledge,
       (select count(*) from sessions)::int as sessions,
       (select count(*) from app_users)::int as app_users`,
  )

/** The text fields on the target that existed before the move, for rewriting mirror refs. */
const TEXT_FIELDS = [
  ['subjects', ['title', 'body', 'conclusion'], `'LAB-' || t.number`],
  ['subject_notes', ['note'], `(select 'LAB-' || s.number from subjects s where s.id = t.subject_id)`],
  ['subject_human_notes', ['body'], `(select 'LAB-' || s.number from subjects s where s.id = t.subject_id)`],
  ['tasks', ['title', 'description', 'resolution', 'checkpoint_summary'], `(select key from projects where id = t.project_id) || '-' || t.number`],
  ['task_notes', ['note'], `(select p.key || '-' || x.number from tasks x join projects p on p.id = x.project_id where x.id = t.task_id)`],
  ['task_comments', ['content'], `(select p.key || '-' || x.number from tasks x join projects p on p.id = x.project_id where x.id = t.task_id)`],
]

const ORIGIN_FIELDS = {
  subjects: ['title', 'body', 'conclusion'],
  subject_notes: ['note'],
  subject_human_notes: ['body'],
  tasks: ['title', 'description', 'resolution'],
  task_notes: ['note'],
  task_comments: ['content'],
}

/** The Lab's origin (the Croft database the target was imported from), by table and id. */
export const readOrigin = async (client) => {
  const origin = new Map()
  for (const [table, fields] of Object.entries(ORIGIN_FIELDS)) {
    const present = await one(client, `select to_regclass($1) is not null as ok`, [`public.${table}`])
    if (!present.ok) continue
    const rows = await q(client, `select id, ${fields.map(ident).join(', ')} from public.${ident(table)}`)
    origin.set(table, new Map(rows.map((r) => [r.id, r])))
  }
  return origin
}

const rewriteTargetText = async ({ target, refs, lab, origin, apply = true }) => {
  if (!refs.size) return { fields: [], summary: summariseRewrites([]) }
  const keys = refKeys(refs)
  const pattern = `\\m(${[...keys].join('|')})-[0-9]`
  const fields = []
  for (const [table, cols, owner] of TEXT_FIELDS) {
    const rows = await q(
      target,
      `select t.id, ${cols.map((c) => `t.${ident(c)}`).join(', ')}, ${owner} as owner
         from public.${ident(table)} t
        where ${cols.map((c) => `t.${ident(c)} ~ $1`).join(' or ')}`,
      [pattern],
    )
    for (const row of rows) {
      const sets = {}
      for (const col of cols) {
        const originRow = origin?.get(table)?.get(row.id)
        const result = rewriteField({ current: row[col], origin: originRow ? originRow[col] : undefined, refs, lab })
        if (!result.changes.length) continue
        sets[col] = result.text
        fields.push({ table, owner: row.owner, field: col, mode: result.mode, changes: result.changes })
      }
      if (apply && Object.keys(sets).length) {
        const names = Object.keys(sets)
        await target.query(
          `update public.${ident(table)} set ${names.map((c, i) => `${ident(c)} = $${i + 2}`).join(', ')} where id = $1`,
          [row.id, ...names.map((c) => sets[c])],
        )
      }
    }
  }
  return { fields, summary: summariseRewrites(fields) }
}

/**
 * Writes the target. Returns what it did, for the report and the checks.
 */
export const writeTarget = async ({ source, target, catalog, facts, pre, options, log = () => {} }) => {
  const out = { tables: {}, merged: [], renumbered: [], urls: 0, rewrites: null, notes: [] }
  const movingKeys = new Set(facts.movingProjects.map((p) => p.key))

  await setTriggers(target, TARGET_TRIGGERS, false)

  // The sets, on the target.
  await target.query(`create temp table mv_users (src uuid primary key, dst uuid not null) on commit drop`)
  await fill(target, 'mv_users', ['src', 'dst'], pre.users.map((u) => ({ src: u.id, dst: u.target_id })))
  await target.query(`create temp table mv_projects (id uuid primary key) on commit drop`)
  await fill(target, 'mv_projects', ['id'], facts.movingProjects.map((p) => ({ id: p.id })))
  await target.query(`create temp table mv_tasks (id uuid primary key) on commit drop`)
  await fill(target, 'mv_tasks', ['id'], facts.sourceTasks.map((t) => ({ id: t.id })))
  const clashByKey = new Map(pre.sessionClash.map((s) => [`${s.platform_source}\u0000${s.external_id}`, s.id]))
  await target.query(`create temp table mv_sessions (src uuid primary key, dst uuid not null) on commit drop`)
  await fill(
    target,
    'mv_sessions',
    ['src', 'dst'],
    pre.sessionKeys.map((s) => ({ src: s.id, dst: clashByKey.get(`${s.platform_source}\u0000${s.external_id}`) ?? s.id })),
  )
  const knowledge = await q(source, `select id from mv_knowledge`)
  await target.query(`create temp table mv_knowledge (id uuid primary key) on commit drop`)
  await fill(target, 'mv_knowledge', ['id'], knowledge)

  // 1. Mirror refs in the target's own text, while the mirrors still exist.
  log('rewriting mirror refs in the target text')
  const refs = refMap({ mirrors: facts.mirrors, collisions: facts.collisions })
  out.rewrites = await rewriteTargetText({ target, refs, lab: options.lab, origin: options.origin })

  // 2. Park the projects whose keys the real ones need, and free the mirrors' external refs.
  const taken = new Set([...facts.targetProjects.map((p) => p.key), ...movingKeys])
  for (const c of facts.collisions) {
    c.temp_key = tempKey(c.key, taken)
    await target.query(`update projects set key = $2 where id = $1`, [c.id, c.temp_key])
  }
  await target.query(`update tasks set external_ref = null where id = any($1::uuid[])`, [facts.mirrors.map((m) => m.id)])

  // 3. Entities the moving rows link to: matched by key, added when missing.
  const entities = await q(source, `select t.id, t.key from entities t where ${MOVING_ENTITIES}`)
  const targetEntities = new Map((await q(target, `select id, key from entities`)).map((e) => [e.key, e.id]))
  await target.query(`create temp table mv_entities (src uuid primary key, dst uuid not null) on commit drop`)
  await fill(target, 'mv_entities', ['src', 'dst'], entities.map((e) => ({ src: e.id, dst: targetEntities.get(e.key) ?? e.id })))
  const newEntities = entities.filter((e) => !targetEntities.has(e.key)).map((e) => e.id)
  out.tables.entities = await copyTable({
    source,
    target,
    table: 'entities',
    catalog,
    where: `t.id = any(array[${newEntities.map((id) => `'${id}'::uuid`).join(',') || 'null::uuid'}])`,
  })
  out.tables.entities.matched = entities.length - newEntities.length

  // 4. Everything else, parents before children.
  const copy = async (table, where = MOVES[table], extraTarget) => {
    log(table)
    out.tables[table] = await copyTable({ source, target, table, catalog, where, extraTarget })
  }
  await copy('projects')
  await copy('project_former_keys')
  await copy('project_repos')
  await copy('project_entities')
  await copy('tasks')
  const links = await q(
    source,
    `select id, parent_id, duplicate_of from tasks
      where id in (select id from mv_tasks)
        and (parent_id in (select id from mv_tasks) or duplicate_of in (select id from mv_tasks))`,
  )
  for (let i = 0; i < links.length; i += 2000) {
    const part = links.slice(i, i + 2000)
    await target.query(
      `update tasks t set parent_id = case when u.parent in (select id from mv_tasks) then u.parent end,
                          duplicate_of = case when u.dup in (select id from mv_tasks) then u.dup end
         from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as u(id, parent, dup) where t.id = u.id`,
      [part.map((r) => r.id), part.map((r) => r.parent_id), part.map((r) => r.duplicate_of)],
    )
  }
  out.tables.tasks.links = links.length
  await copy('task_projects', `(${MOVES.task_projects}) and not (${DROPPED.task_projects})`)
  await copy('task_former_refs', `(${MOVES.task_former_refs}) and not (${DROPPED.task_former_refs})`)
  await copy('task_deps', `(${MOVES.task_deps}) and not (${DROPPED.task_deps})`)
  await copy('task_notes')
  await copy('task_comments')
  await copy('task_attachments')
  await copy('task_activity_events')

  log('sessions')
  const clashIds = pre.sessionClash.map((s) => s.id)
  await source.query(`create temp table mv_session_clash (platform_source text, external_id text) on commit drop`)
  if (clashIds.length) {
    await source.query(`insert into mv_session_clash select * from unnest($1::text[], $2::text[])`, [
      pre.sessionClash.map((s) => s.platform_source),
      pre.sessionClash.map((s) => s.external_id),
    ])
  }
  out.tables.sessions = await copyTable({
    source,
    target,
    table: 'sessions',
    catalog,
    where: `(${MOVES.sessions}) and not exists (select 1 from mv_session_clash k
              where k.platform_source = t.platform_source and k.external_id = t.external_id)`,
  })
  if (clashIds.length) {
    const rows = await one(
      source,
      `select coalesce(json_agg(s), '[]')::text as rows from sessions s
        where s.id in (select id from mv_sessions)
          and (s.platform_source, s.external_id) in (select platform_source, external_id from mv_session_clash)`,
    )
    const merged = await target.query(
      `update sessions d set
          request = coalesce(d.request, r.request), learned = coalesce(d.learned, r.learned),
          completed = coalesce(d.completed, r.completed), next_steps = coalesce(d.next_steps, r.next_steps),
          cwd = coalesce(d.cwd, r.cwd), project_id = coalesce(d.project_id, r.project_id),
          started_at = least(d.started_at, r.started_at), ended_at = greatest(d.ended_at, r.ended_at),
          tool_calls = greatest(d.tool_calls, r.tool_calls),
          task_refs = array(select distinct unnest(d.task_refs || r.task_refs) order by 1)
         from json_populate_recordset(null::sessions, $1::json) r
        where d.platform_source = r.platform_source and d.external_id = r.external_id`,
      [rows.rows],
    )
    out.tables.sessions.merged = merged.rowCount
  }
  await copy('file_touches')
  await copy('knowledge')
  const superseded = await q(
    source,
    `select id, superseded_by from knowledge where id in (select id from mv_knowledge) and superseded_by is not null`,
  )
  const within = superseded.filter((r) => knowledge.some((k) => k.id === r.superseded_by))
  if (within.length) {
    await target.query(
      `update knowledge k set superseded_by = u.s from unnest($1::uuid[], $2::uuid[]) as u(id, s) where k.id = u.id`,
      [within.map((r) => r.id), within.map((r) => r.superseded_by)],
    )
  }
  const orphaned = superseded.filter((r) => !knowledge.some((k) => k.id === r.superseded_by))
  if (orphaned.length) {
    // Its successor stays behind. Say so in the entry, since the link cannot cross.
    const successors = await q(source, `select k.id, s.slug from knowledge k join knowledge s on s.id = k.superseded_by where k.id = any($1::uuid[])`, [
      orphaned.map((r) => r.id),
    ])
    for (const s of successors) {
      await target.query(
        `update knowledge set body = body || $2 where id = $1`,
        [s.id, `\n\nSuperseded by \`${s.slug}\`, which stayed on ${trimBase(options.sourceBaseUrl)} when this entry moved (${options.task}).`],
      )
    }
    out.notes.push(...successors.map((s) => `knowledge whose successor stays behind: superseded_by cleared, the successor ${s.slug} named in its body`))
  }
  out.tables.knowledge.superseded_links = within.length
  await copy('knowledge_projects', `(${MOVES.knowledge_projects}) and not (${DROPPED.knowledge_projects})`)
  await copy('knowledge_entities')
  await copy('knowledge_files')
  await copy('knowledge_revisions')
  await copy('knowledge_recall_state')
  await copy('knowledge_reads')

  // 5. Merge the mirrors into the tasks they stood for.
  log('merging mirrors')
  if (facts.mirrors.length) {
    await target.query(
      `create temp table mv_merge (mirror uuid primary key, real uuid not null, real_project uuid not null,
         mirror_ref text not null, real_ref text not null, subject uuid, note text not null) on commit drop`,
    )
    // A merged task's links to the mirror, or to the Croft todo behind it, now point at
    // itself or at nothing: they are cleared, and the note keeps them. Refs in the note use
    // a non-breaking hyphen, so they read as written but are not mentions of the real tasks
    // that now hold those numbers.
    const targetHost = new URL(options.targetBaseUrl).host
    const quiet = (text) => text.replace(/\b([A-Z][A-Z0-9]{1,9})-(\d)/g, '$1\u2011$2')
    const realById = new Map(facts.sourceTasks.map((t) => [t.id, t]))
    const selfRef = (ref) => typeof ref === 'string' && (/^croft:/.test(ref) || ref.startsWith(`${targetHost}/`))
    const selfUrl = (url) => typeof url === 'string' && url.startsWith(`${trimBase(options.targetBaseUrl)}/`)
    const cleared = []
    const rows = facts.mirrors.map((m) => {
      const [, num] = /-(\d+)$/.exec(m.ref)
      const key = m.ref.slice(0, m.ref.lastIndexOf('-'))
      const real = realById.get(m.real_id) ?? {}
      const links = []
      if (selfRef(real.external_ref)) links.push(`external_ref ${quiet(real.external_ref)}`)
      if (selfUrl(real.external_url)) links.push(`external_url ${real.external_url}`)
      if (links.length) cleared.push({ id: m.real_id, ref: selfRef(real.external_ref), url: selfUrl(real.external_url) })
      const origin = m.external_ref ? `, first Croft's ${m.external_ref.replace(/^.*\//, '')} (${m.external_ref})` : ''
      return {
        ...m,
        note:
          `Merged the Lab mirror of this task into it when ${m.real_ref.slice(0, m.real_ref.lastIndexOf('-'))} moved from ${options.sourceName} to ${options.targetName} (${options.task}). ` +
            `The mirror was ${quiet(m.ref)} on ${options.targetName} (number ${num} in the Lab's ${key} project)${origin}.` +
            (m.subject_number ? ` Its subject link (LAB-${m.subject_number}), notes and history are now on this task.` : ' Its notes and history are now on this task.') +
            (links.length ? ` This task's links to the mirror were cleared: ${links.join(', ')}.` : ''),
      }
    })
    for (const c of cleared) {
      await target.query(
        `update tasks set external_ref = case when $2 then null else external_ref end,
                          external_url = case when $3 then null else external_url end where id = $1`,
        [c.id, c.ref, c.url],
      )
    }
    await target.query(
      `insert into mv_merge select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::uuid[], $7::text[])`,
      [
        rows.map((m) => m.id),
        rows.map((m) => m.real_id),
        rows.map((m) => m.real_project_id),
        rows.map((m) => m.ref),
        rows.map((m) => m.real_ref),
        rows.map((m) => m.subject_id),
        rows.map((m) => m.note),
      ],
    )
    const merged = {}
    merged.subjects = (
      await target.query(
        `update tasks r set subject_id = m.subject from mv_merge m
          where r.id = m.real and m.subject is not null and r.subject_id is null`,
      )
    ).rowCount
    merged.duplicate_notes = (
      await target.query(
        `delete from task_notes n using mv_merge m
          where n.task_id = m.mirror and n.content_hash is not null
            and exists (select 1 from task_notes x where x.task_id = m.real and x.content_hash = n.content_hash)`,
      )
    ).rowCount
    merged.notes = (await target.query(`update task_notes n set task_id = m.real from mv_merge m where n.task_id = m.mirror`)).rowCount
    await target.query(
      `delete from task_comments c using mv_merge m
        where c.task_id = m.mirror and c.mutation_id is not null
          and exists (select 1 from task_comments x where x.task_id = m.real and x.mutation_id = c.mutation_id)`,
    )
    merged.comments = (await target.query(`update task_comments c set task_id = m.real from mv_merge m where c.task_id = m.mirror`)).rowCount
    merged.attachments = (await target.query(`update task_attachments a set task_id = m.real from mv_merge m where a.task_id = m.mirror`)).rowCount
    merged.duplicate_events = (
      await target.query(
        `delete from task_activity_events e using mv_merge m
          where e.task_id = m.mirror and e.event in ('git_commit', 'git_push') and e.data ? 'sha'
            and exists (select 1 from task_activity_events x where x.task_id = m.real and x.event = e.event and x.data->>'sha' = e.data->>'sha')`,
      )
    ).rowCount
    merged.events = (
      await target.query(
        `update task_activity_events e
            set task_id = m.real, project_id = m.real_project,
                data = e.data || jsonb_build_object('merged_from', m.mirror_ref)
                     || case when e.data ? 'ref' then jsonb_build_object('ref', m.real_ref) else '{}'::jsonb end
           from mv_merge m where e.task_id = m.mirror`,
      )
    ).rowCount
    merged.deps =
      (await target.query(`delete from task_deps d using mv_merge m where (d.blocked_id = m.mirror or d.blocking_id = m.mirror)
          and exists (select 1 from task_deps x where x.blocked_id = case when d.blocked_id = m.mirror then m.real else d.blocked_id end
                                                 and x.blocking_id = case when d.blocking_id = m.mirror then m.real else d.blocking_id end)`)).rowCount +
      (await target.query(`update task_deps d set blocked_id = m.real from mv_merge m where d.blocked_id = m.mirror and d.blocking_id <> m.real`)).rowCount +
      (await target.query(`update task_deps d set blocking_id = m.real from mv_merge m where d.blocking_id = m.mirror and d.blocked_id <> m.real`)).rowCount
    await target.query(`delete from task_projects x using mv_merge m where x.task_id = m.mirror and x.project_id = m.real_project`)
    await target.query(
      `delete from task_projects x using mv_merge m where x.task_id = m.mirror
          and exists (select 1 from task_projects y where y.task_id = m.real and y.project_id = x.project_id)`,
    )
    merged.task_projects = (await target.query(`update task_projects x set task_id = m.real from mv_merge m where x.task_id = m.mirror`)).rowCount
    merged.former_refs = (await target.query(`update task_former_refs x set task_id = m.real from mv_merge m where x.task_id = m.mirror`)).rowCount
    merged.children = (await target.query(`update tasks t set parent_id = m.real from mv_merge m where t.parent_id = m.mirror and t.id <> m.real`)).rowCount
    merged.duplicates = (await target.query(`update tasks t set duplicate_of = m.real from mv_merge m where t.duplicate_of = m.mirror and t.id <> m.real`)).rowCount
    await target.query(
      `insert into task_notes (task_id, actor_type, actor_id, note, kind, created_at)
       select m.real, 'agent', $1, m.note, 'note', now() from mv_merge m`,
      [options.actor],
    )
    merged.mirrors_deleted = (await target.query(`delete from tasks t using mv_merge m where t.id = m.mirror`)).rowCount
    await target.query(
      `update tasks t set comments_text = (select string_agg(c.content, E'\\n' order by c.created_at) from task_comments c where c.task_id = t.id)
        where t.id in (select real from mv_merge)`,
    )
    merged.links_cleared = cleared.length
    out.merge = merged
    out.merged = rows.map((m) => ({ mirror: m.ref, real: m.real_ref, subject: m.subject_number ? `LAB-${m.subject_number}` : null, external_ref: m.external_ref }))
  }

  // 6. What is left of a parked project joins the real one.
  for (const c of facts.collisions) {
    for (const r of c.renumber) {
      await target.query(`update tasks set project_id = $2, number = $3 where id = $1`, [r.id, c.real_id, r.number])
      out.renumbered.push({ from: r.from, to: r.to })
    }
    if (c.renumber.length) await target.query(`update projects set task_counter = $2 where id = $1`, [c.real_id, c.counter_after])
    const subjects = (await target.query(`update subjects set project_id = $2 where project_id = $1`, [c.id, c.real_id])).rowCount
    const events = (await target.query(`update task_activity_events set project_id = $2 where project_id = $1`, [c.id, c.real_id])).rowCount
    await target.query(`update lab_settings set home_project_id = $2 where home_project_id = $1`, [c.id, c.real_id])
    await target.query(`update task_projects set project_id = $2 where project_id = $1
                          and task_id not in (select id from tasks where project_id = $2)`, [c.id, c.real_id])
    await target.query(`delete from task_projects where project_id = $1`, [c.id])
    await target.query(`update file_touches set project_id = $2 where project_id = $1`, [c.id, c.real_id])
    await target.query(`update sessions set project_id = $2 where project_id = $1`, [c.id, c.real_id])
    await target.query(`update knowledge_projects set project_id = $2 where project_id = $1
                          and knowledge_id not in (select knowledge_id from knowledge_projects where project_id = $2)`, [c.id, c.real_id])
    await target.query(`update project_repos set project_id = $2 where project_id = $1
                          and remote not in (select remote from project_repos where project_id = $2)`, [c.id, c.real_id])
    await target.query(`update project_entities set project_id = $2 where project_id = $1
                          and entity_id not in (select entity_id from project_entities where project_id = $2)`, [c.id, c.real_id])
    // The parked project's key now names the real one, so its former refs would name the wrong tasks.
    out.parkedFormerRefs = (out.parkedFormerRefs ?? 0) + (await target.query(`delete from task_former_refs where project_id = $1`, [c.id])).rowCount
    const left = await n(target, `select count(*) as n from tasks where project_id = $1`, [c.id])
    if (left) throw new Error(`${c.key} on the target still holds ${left} task(s) after the merge`)
    await target.query(`delete from projects where id = $1`, [c.id])
    out.notes.push(`${c.key}: the target's project ${c.id} was replaced by the real one; ${subjects} subject(s) and ${events} event(s) now point at it`)
  }

  // 6b. A moving task that lost a link to one that stays gets a note saying so.
  const sourceUrl = (ref) => {
    const i = ref.lastIndexOf('-')
    return `${trimBase(options.sourceBaseUrl)}/projects/${ref.slice(0, i)}/tasks/${ref.slice(i + 1)}`
  }
  const lost = [
    ...(options.crossing?.parents ?? []).filter((p) => p.child_moves).map((p) => ({
      task: p.child_id,
      text: `Its parent ${p.parent} stayed on ${options.sourceName} when this project moved to ${options.targetName} (${options.task}), so the sub-task link was dropped: ${sourceUrl(p.parent)}`,
    })),
    ...(options.crossing?.alsoIn ?? []).filter((a) => a.task_moves).map((a) => ({
      task: a.task_id,
      text: `It was also filed under ${a.also}, which stayed on ${options.sourceName} when this project moved to ${options.targetName} (${options.task}); that link was dropped.`,
    })),
  ]
  for (const note of lost) {
    await target.query(
      `insert into task_notes (task_id, actor_type, actor_id, note, kind, created_at) values ($1, 'agent', $2, $3, 'note', now())`,
      [note.task, options.actor, note.text],
    )
  }
  out.lostLinkNotes = lost.length

  // 7. Links into a moving project on the source now point at the target.
  const urlArgs = { fromBase: options.sourceBaseUrl, toBase: options.targetBaseUrl, movingKeys }
  const linked = await q(
    target,
    `select id, external_url, handoff_url from tasks where external_url like $1 or handoff_url like $1`,
    [`${trimBase(options.sourceBaseUrl)}/projects/%`],
  )
  for (const t of linked) {
    const e = moveUrl(t.external_url, urlArgs)
    const h = moveUrl(t.handoff_url, urlArgs)
    if (e === t.external_url && h === t.handoff_url) continue
    await target.query(`update tasks set external_url = $2, handoff_url = $3 where id = $1`, [t.id, e, h])
    out.urls += 1
  }

  // 8. Mentions are derived from the text: rebuild them all, now that every task is here.
  log('rebuilding mentions')
  const has = `~ '[A-Z][A-Z0-9]{1,9}-[0-9]'`
  await target.query(`delete from task_mentions`)
  await target.query(`delete from subject_mentions`)
  await target.query(`select count(*) from (select task_mentions_refresh('description', id, null, null, description, created_at) from tasks where description ${has}) x`)
  await target.query(
    `select count(*) from (select task_mentions_refresh('resolution', id, null, null, resolution, coalesce(resolved_at, updated_at)) from tasks where resolution ${has}) x`,
  )
  await target.query(`select count(*) from (select task_mentions_refresh('note', task_id, id, null, note, created_at) from task_notes where note ${has}) x`)
  await target.query(
    `select count(*) from (select task_mentions_refresh('comment', task_id, null, id, content, created_at) from task_comments where content ${has}) x`,
  )
  out.mentions = await one(
    target,
    `select (select count(*) from task_mentions)::int as task_mentions, (select count(*) from subject_mentions)::int as subject_mentions`,
  )

  await setTriggers(target, TARGET_TRIGGERS, true)
  return out
}

/**
 * Empties the source of what moved. Rows that stay but pointed at something
 * that moved lose that pointer (a foreign key would otherwise delete them).
 */
export const writeSource = async ({ source, options, crossing, log = () => {} }) => {
  const out = { deleted: {}, updated: {}, notes: 0 }
  await setTriggers(source, SOURCE_TRIGGERS, false)
  const movingKeys = new Set((await q(source, `select key from mv_projects`)).map((r) => r.key))

  log('source: links that stay')
  // A touch that stays keeps its task; the session or project that moved is dropped from it,
  // since the cascade from either would delete the whole row.
  out.updated.file_touches_session = (
    await source.query(
      `update file_touches t set session_id = null
        where t.session_id in (select id from mv_sessions) and not (${MOVES.file_touches})`,
    )
  ).rowCount
  out.updated.file_touches_project = (
    await source.query(
      `update file_touches t set project_id = null
        where t.project_id in (select id from mv_projects) and not (${MOVES.file_touches})`,
    )
  ).rowCount
  out.updated.knowledge_session_ref = (
    await source.query(
      `update knowledge k set source_session_ref = s.external_id
         from sessions s
        where s.id = k.source_session_id and s.id in (select id from mv_sessions)
          and k.id not in (select id from mv_knowledge where scope = 'move') and k.source_session_ref is null`,
    )
  ).rowCount

  const urlArgs = { fromBase: options.sourceBaseUrl, toBase: options.targetBaseUrl, movingKeys }
  let urls = 0
  for (const t of await q(
    source,
    `select id, external_url from tasks where external_url like $1 and id not in (select id from mv_tasks)`,
    [`${trimBase(options.sourceBaseUrl)}/projects/%`],
  )) {
    const e = moveUrl(t.external_url, urlArgs)
    if (e === t.external_url) continue
    await source.query(`update tasks set external_url = $2 where id = $1`, [t.id, e])
    urls += 1
  }
  out.updated.external_urls = urls

  // A task that stays and loses a link to one that moved gets a note saying where it went.
  const target = trimBase(options.targetBaseUrl)
  const urlOf = (ref) => {
    const i = ref.lastIndexOf('-')
    return `${target}/projects/${ref.slice(0, i)}/tasks/${ref.slice(i + 1)}`
  }
  const notes = [
    ...crossing.parents.filter((p) => !p.child_moves).map((p) => ({
      task: p.child_id,
      text: `Its parent ${p.parent} moved to ${options.targetName} with its project (${options.task}), so the sub-task link was dropped: ${urlOf(p.parent)}`,
    })),
    ...crossing.alsoIn.filter((a) => !a.task_moves).map((a) => ({
      task: a.task_id,
      text: `It was also filed under ${a.also}, which moved to ${options.targetName} (${options.task}); that link was dropped.`,
    })),
  ]
  for (const note of notes) {
    await source.query(
      `insert into task_notes (task_id, actor_type, actor_id, note, kind, created_at) values ($1, 'agent', $2, $3, 'note', now())`,
      [note.task, options.actor, note.text],
    )
  }
  out.notes = notes.length

  log('source: deleting what moved')
  out.deleted.knowledge_reads = (
    await source.query(`delete from knowledge_reads where slug in (select slug from mv_knowledge where scope = 'move')`)
  ).rowCount
  out.deleted.knowledge = (
    await source.query(`delete from knowledge where id in (select id from mv_knowledge where scope = 'move')`)
  ).rowCount
  out.deleted.task_activity_events = (await source.query(`delete from task_activity_events t where ${MOVES.task_activity_events}`)).rowCount
  out.deleted.file_touches = (await source.query(`delete from file_touches t where ${MOVES.file_touches}`)).rowCount
  out.deleted.sessions = (await source.query(`delete from sessions where id in (select id from mv_sessions)`)).rowCount
  out.deleted.tasks = await n(source, `select count(*) as n from mv_tasks`)
  out.deleted.projects = (await source.query(`delete from projects where id in (select id from mv_projects)`)).rowCount

  await setTriggers(source, SOURCE_TRIGGERS, true)
  return out
}

export const snapshots = { stayingSnapshot, targetSnapshot }
export { LEFT_ALONE, TABLES, MOVES, DROPPED }
