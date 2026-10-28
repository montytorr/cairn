/**
 * Checks after writing and before committing. Each one is a fact about the
 * finished state, read from the databases, not from what the writer says it did.
 */
import { disabledTriggers } from './engine.mjs'
import { trimBase } from './plan.mjs'

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0]

/** Table totals, so every insert and delete can be balanced. */
export const TOTALS = [
  'projects',
  'project_former_keys',
  'project_repos',
  'project_entities',
  'entities',
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

export const totals = async (client) => {
  const row = await one(client, `select ${TOTALS.map((t) => `(select count(*) from public.${t})::int as ${t}`).join(', ')}`)
  return row
}

/** id, project and number of every moving task, as one digest. */
const taskDigest = `select count(*)::int as n,
  md5(coalesce(string_agg(t.id::text || ':' || p.key || '-' || t.number, ',' order by t.id), '')) as digest
  from tasks t join projects p on p.id = t.project_id where t.id in (select id from mv_tasks)`

export const sourceDigest = async (source) => one(source, taskDigest)

export const verify = async ({ source, target, facts, written, removedFromSource, before, options }) => {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })

  // Every moving task is on the target with its id, key and number: its ref resolves there.
  const there = await one(target, taskDigest)
  check('moving tasks on the target, same id, key and number', there.n === before.digest.n && there.digest === before.digest.digest, `${there.n} of ${before.digest.n}`)

  const projects = await one(
    target,
    `select count(*)::int as n, count(*) filter (where p.task_counter >= coalesce((select max(number) from tasks where project_id = p.id), 0))::int as ok
       from projects p where p.id in (select id from mv_projects)`,
  )
  check('moving projects on the target, counters past their numbers', projects.n === facts.movingProjects.length && projects.ok === projects.n, `${projects.n} of ${facts.movingProjects.length}`)

  // Every table balances: what was there, plus what went in, minus what the merge removed.
  const after = await totals(target)
  const merge = written.merge ?? {}
  const extra = {
    tasks: -(merge.mirrors_deleted ?? 0),
    projects: -facts.collisions.length,
    task_notes: (merge.mirrors_deleted ?? 0) - (merge.duplicate_notes ?? 0) + (written.lostLinkNotes ?? 0),
    task_activity_events: -(merge.duplicate_events ?? 0),
    task_former_refs: -(written.parkedFormerRefs ?? 0),
  }
  for (const table of Object.keys(after)) {
    const added = written.tables[table]?.written ?? 0
    const expected = before.target[table] + added + (extra[table] ?? 0)
    check(`target ${table}`, after[table] === expected, `${before.target[table]} + ${added}${extra[table] ? ` ${extra[table] > 0 ? '+' : '-'} ${Math.abs(extra[table])}` : ''} = ${expected}, found ${after[table]}`)
  }
  for (const [table, r] of Object.entries(written.tables)) {
    check(`copied ${table}`, r.read === r.written, `${r.written} of ${r.read}`)
  }

  const mirrorsLeft = await one(
    target,
    `select count(*)::int as n from tasks t join projects p on p.id = t.project_id
      where t.handoff_tracker = 'cairn' and t.handoff_url like $1 and split_part(t.handoff_ref, '-', 1) = any($2::text[])`,
    [`${trimBase(options.sourceBaseUrl)}/%`, facts.movingProjects.map((p) => p.key)],
  )
  check('no mirror of a moving task is left on the target', mirrorsLeft.n === 0, `${mirrorsLeft.n} left`)
  if (facts.mirrors.length) {
    const selfLinked = await one(
      target,
      `select count(*)::int as n from tasks where id in (select real from mv_merge)
          and (external_ref like 'croft:%' or external_ref like $1 or external_url like $2)`,
      [`${new URL(options.targetBaseUrl).host}/%`, `${trimBase(options.targetBaseUrl)}/%`],
    )
    check('merged tasks keep no link to their mirror', selfLinked.n === 0, `${selfLinked.n} left`)
  }
  const parked = await one(target, `select count(*)::int as n from projects where id = any($1::uuid[])`, [facts.collisions.map((c) => c.id)])
  check('replaced target projects are gone', parked.n === 0, `${parked.n} left`)
  const unchanged = await one(
    target,
    `select (select count(*) from subjects)::int as subjects, (select count(*) from subject_notes)::int as subject_notes,
            (select count(*) from subject_human_notes)::int as subject_human_notes, (select count(*) from app_users)::int as app_users`,
  )
  for (const k of Object.keys(unchanged)) check(`target ${k} unchanged`, unchanged[k] === before.targetLab[k], `${before.targetLab[k]} -> ${unchanged[k]}`)

  // The source keeps nothing that moved, and nothing that stays changed.
  const left = await one(
    source,
    `select
       (select count(*) from projects where id in (select id from mv_projects))::int as projects,
       (select count(*) from tasks where id in (select id from mv_tasks))::int as tasks,
       (select count(*) from sessions where id in (select id from mv_sessions))::int as sessions,
       (select count(*) from knowledge where id in (select id from mv_knowledge where scope = 'move'))::int as knowledge,
       (select count(*) from knowledge_reads where slug in (select slug from mv_knowledge where scope = 'move'))::int as knowledge_reads,
       (select count(*) from task_activity_events where task_id in (select id from mv_tasks) or project_id in (select id from mv_projects))::int as events,
       (select count(*) from file_touches where task_id in (select id from mv_tasks) or session_id in (select id from mv_sessions)
                                            or project_id in (select id from mv_projects))::int as file_touches,
       (select count(*) from knowledge_projects where project_id in (select id from mv_projects))::int as knowledge_projects`,
  )
  for (const [k, v] of Object.entries(left)) check(`source holds no moved ${k}`, v === 0, `${v} left`)
  const staying = await before.stayingSnapshot(source)
  for (const [k, v] of Object.entries(before.staying)) {
    const expected = k === 'task_notes' ? v + removedFromSource.notes : v
    check(`source ${k} that stay`, staying[k] === expected, `${expected} expected, ${staying[k]} found`)
  }

  for (const [side, client] of [
    ['source', source],
    ['target', target],
  ]) {
    const off = await disabledTriggers(client)
    check(`${side} triggers all enabled`, off.length === 0, off.length ? off.join(', ') : 'all on')
  }
  return checks
}
