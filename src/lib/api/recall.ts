import { pool } from '@/lib/db/client'
import { searchAll } from './search'
import { stalenessFor } from './staleness'
import { excerptAround } from './mentions'

/**
 * What Cairn already knows that bears on one task (CAIRN-268).
 *
 * `check` answers "has this subject been worked on" from a phrase. This starts
 * from a task and answers the question an agent has when it picks one up:
 * which decisions constrain it, and which facts apply. Two sources, one read:
 *
 *   decisions  resolutions, decision and finding notes on tasks related to
 *              this one — by a ref written either way (CAIRN-267), by parent,
 *              child or dependency, or by a similar title
 *   knowledge  facts linked to the files this task touched (CAIRN-269),
 *              learned on this task or a related one, or matching its terms
 *
 * Every line says why it was picked. A recall that cannot justify a line is a
 * search result wearing a better name, and the reader cannot tell which lines
 * to trust.
 */

type Why =
  | 'mentions this task'
  | 'mentioned here'
  | 'parent'
  | 'sub-task'
  | 'blocks this'
  | 'blocked by this'
  | 'similar title'

const WEIGHT: Record<Why, number> = {
  'mentions this task': 5,
  'blocks this': 4,
  'mentioned here': 3,
  parent: 3,
  'sub-task': 2,
  'blocked by this': 2,
  'similar title': 1,
}

export type RecalledDecision = {
  ref: string
  title: string
  status: string
  kind: 'resolution' | 'decision' | 'finding'
  text: string
  by: string | null
  at: string
  why: string[]
}

export type RecalledKnowledge = {
  slug: string
  title: string
  stale: boolean
  /** No files to judge by, and unconfirmed this many days (staleness.ts). */
  unverified_days: number | null
  verified: boolean
  why: string[]
}

export type Recall = {
  ref: string
  title: string
  decisions: RecalledDecision[]
  knowledge: RecalledKnowledge[]
  omitted: { decisions: number; knowledge: number }
}

const TEXT_BUDGET = 400

const clip = (text: string, around?: string) => {
  if (around) return excerptAround(text, around)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_BUDGET ? `${flat.slice(0, TEXT_BUDGET)}…` : flat
}

type Task = {
  id: string
  ref: string
  title: string
  description: string | null
  project_key: string
  project_id: string
}

/** Tasks related to this one by structure or by a written ref, with why. */
const relatedTasks = async (task: Task): Promise<Map<string, Set<Why>>> => {
  const { rows } = await pool().query(
    `select source_task_id as id, 'mentions this task' as why from task_mentions where target_task_id = $1
     union all select target_task_id, 'mentioned here' from task_mentions where source_task_id = $1
     union all select parent_id, 'parent' from tasks where id = $1 and parent_id is not null
     union all select id, 'sub-task' from tasks where parent_id = $1
     union all select blocking_id, 'blocks this' from task_deps where blocked_id = $1
     union all select blocked_id, 'blocked by this' from task_deps where blocking_id = $1`,
    [task.id],
  )
  const out = new Map<string, Set<Why>>()
  for (const r of rows as { id: string; why: Why }[]) {
    if (r.id === task.id) continue
    out.set(r.id, (out.get(r.id) ?? new Set()).add(r.why))
  }
  return out
}

/** Answered tasks whose words overlap this one's, through the same index `check` uses. */
const similarTasks = async (userId: string, task: Task, exclude: Set<string>) => {
  const q = [task.title, (task.description ?? '').slice(0, 300)].join(' ')
  const { rows } = await searchAll(userId, q, { kinds: ['task'] }, 12)
  return rows
    .filter((r) => r.kind === 'task' && r.answered && r.id !== task.id && !exclude.has(r.id))
    .slice(0, 6)
    .map((r) => r.id)
}

const decisionsFrom = async (task: Task, related: Map<string, Set<Why>>): Promise<RecalledDecision[]> => {
  const ids = [...related.keys()]
  if (ids.length === 0) return []

  const [{ rows }, { rows: pointed }] = await Promise.all([
    pool().query(
      `with related as (select unnest($1::uuid[]) as id)
     select p.key || '-' || t.number as ref, t.id, t.title, t.status,
            'resolution' as kind, t.resolution as text, t.resolved_by as by,
            coalesce(t.resolved_at, t.updated_at) as at, null::uuid as note_id
       from related r join tasks t on t.id = r.id join projects p on p.id = t.project_id
      where t.resolution is not null
     union all
     select ref, id, title, status, kind, text, by, at, note_id from (
       select p.key || '-' || t.number as ref, t.id, t.title, t.status,
              n.kind, n.note as text, n.actor_id as by, n.created_at as at, n.id as note_id,
              row_number() over (partition by t.id order by (n.kind = 'decision') desc, n.created_at desc) as nth
         from related r join tasks t on t.id = r.id join projects p on p.id = t.project_id
         join task_notes n on n.task_id = t.id and n.kind in ('decision', 'finding')
     ) notes
     where nth <= 2`,
      [ids],
    ),
    // A note that names this task is the reason its task came up at all, so
    // it is shown whatever its rank among that task's notes.
    pool().query(
      `select m.note_id from task_mentions m join task_notes n on n.id = m.note_id
        where m.target_task_id = $1 and n.kind in ('decision', 'finding')`,
      [task.id],
    ),
  ])
  const namesThisTask = new Set(pointed.map((r) => r.note_id as string))

  const { rows: extra } = namesThisTask.size
    ? await pool().query(
        `select p.key || '-' || t.number as ref, t.id, t.title, t.status, n.kind, n.note as text,
                n.actor_id as by, n.created_at as at, n.id as note_id
           from task_notes n join tasks t on t.id = n.task_id join projects p on p.id = t.project_id
          where n.id = any($1::uuid[])`,
        [[...namesThisTask]],
      )
    : { rows: [] }

  const seen = new Set<string>()
  const all = [...extra, ...rows].filter((r) => {
    const key = `${r.id}:${r.note_id ?? 'resolution'}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return all
    .map((r) => {
      const whys = [...(related.get(r.id as string) ?? [])]
      const mentionsHere = r.note_id && namesThisTask.has(r.note_id as string)
      return {
        score:
          Math.max(...whys.map((w) => WEIGHT[w]), 0) +
          (mentionsHere ? 3 : 0) +
          (r.kind === 'finding' ? 0 : 1),
        decision: {
          ref: r.ref as string,
          title: r.title as string,
          status: r.status as string,
          kind: r.kind as RecalledDecision['kind'],
          text: clip(String(r.text ?? ''), mentionsHere ? task.ref : undefined),
          by: (r.by as string | null) ?? null,
          at: new Date(r.at as string).toISOString(),
          why: mentionsHere ? ['names this task', ...whys.filter((w) => w !== 'mentions this task')] : whys,
        },
      }
    })
    .sort((a, b) => b.score - a.score || b.decision.at.localeCompare(a.decision.at))
    .map((x) => x.decision)
}

const knowledgeFor = async (
  userId: string,
  task: Task,
  related: string[],
): Promise<RecalledKnowledge[]> => {
  const { rows } = await pool().query(
    `select k.id, k.slug, k.title, k.body, k.verified_at, k.created_at, k.source_task_id,
            k.source_session_id, k.source_session_ref, array_agg(distinct r.why) as why
       from (
         select kf.knowledge_id, 'about ' || kf.path as why
           from knowledge_files kf
           join file_touches ft on ft.path = kf.path
           join tasks touched on touched.id = ft.task_id
          where ft.task_id = $1
            and (
              exists (
                select 1 from knowledge_projects kp
                 where kp.knowledge_id = kf.knowledge_id
                   and kp.project_id = touched.project_id
              )
              or exists (
                select 1 from knowledge_entities ke
                join project_entities pe on pe.entity_id = ke.entity_id
                 where ke.knowledge_id = kf.knowledge_id
                   and pe.project_id = touched.project_id
              )
              or (
                not exists (select 1 from knowledge_projects kp where kp.knowledge_id = kf.knowledge_id)
                and not exists (select 1 from knowledge_entities ke where ke.knowledge_id = kf.knowledge_id)
              )
            )
         union all
         select k.id, case when k.source_task_id = $1 then 'learned on this task'
                           else 'learned on ' || p.key || '-' || t.number end
           from knowledge k join tasks t on t.id = k.source_task_id join projects p on p.id = t.project_id
          where (k.source_task_id = any($2::uuid[]) or k.source_task_id = $1)
            and (
              exists (
                select 1 from knowledge_projects kp
                 where kp.knowledge_id = k.id and kp.project_id = $3
              )
              or exists (
                select 1 from knowledge_entities ke
                join project_entities pe on pe.entity_id = ke.entity_id
                 where ke.knowledge_id = k.id and pe.project_id = $3
              )
              or (
                not exists (select 1 from knowledge_projects kp where kp.knowledge_id = k.id)
                and not exists (select 1 from knowledge_entities ke where ke.knowledge_id = k.id)
              )
            )
       ) r
       join knowledge k on k.id = r.knowledge_id
      where k.superseded_by is null
      group by k.id`,
    [task.id, related, task.project_id],
  )

  const found = new Map<string, { row: Record<string, unknown>; why: string[]; score: number }>()
  for (const r of rows) {
    const why = (r.why as string[]).sort()
    found.set(r.id as string, { row: r, why, score: 10 + why.length })
  }

  // Terms last, and scoped to the task's project: a fact true only of another
  // codebase that shares a word with this title is the noise this avoids.
  const q = [task.title, (task.description ?? '').slice(0, 300)].join(' ')
  const { rows: searched } = await searchAll(userId, q, { kinds: ['knowledge'], project: task.project_key }, 8)
  const bySlug = searched.filter((s) => s.kind === 'knowledge').map((s) => s.ref)
  if (bySlug.length > 0) {
    const { rows: hits } = await pool().query(
      `select id, slug, title, body, verified_at, created_at, source_task_id, source_session_id,
              source_session_ref
         from knowledge where slug = any($1) and superseded_by is null`,
      [bySlug],
    )
    for (const h of hits) {
      const rank = bySlug.indexOf(h.slug as string)
      const existing = found.get(h.id as string)
      if (existing) existing.why.push('matches its terms')
      else found.set(h.id as string, { row: h, why: ['matches its terms'], score: 5 - rank / 10 })
    }
  }

  const entries = [...found.values()]
  const aged = await stalenessFor(
    userId,
    entries.map(({ row }) => ({
      id: row.id as string,
      body: String(row.body ?? ''),
      verified_at: (row.verified_at as string | null) ?? null,
      created_at: row.created_at ? new Date(row.created_at as string).toISOString() : null,
      source_task_id: (row.source_task_id as string | null) ?? null,
      source_session_id: (row.source_session_id as string | null) ?? null,
      source_session_ref: (row.source_session_ref as string | null) ?? null,
    })),
  )

  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ row, why }) => ({
      slug: row.slug as string,
      title: row.title as string,
      stale: aged.get(row.id as string)?.stale ?? false,
      unverified_days: aged.get(row.id as string)?.unverifiedDays ?? null,
      verified: Boolean(row.verified_at),
      why,
    }))
}

export const recallFor = async (
  userId: string,
  task: Task,
  limits: { decisions?: number; knowledge?: number } = {},
): Promise<Recall> => {
  const related = await relatedTasks(task)
  for (const id of await similarTasks(userId, task, new Set(related.keys()))) {
    related.set(id, new Set<Why>(['similar title']))
  }

  const [decisions, knowledge] = await Promise.all([
    decisionsFrom(task, related),
    knowledgeFor(userId, task, [...related.keys()]),
  ])

  const maxDecisions = limits.decisions ?? 8
  const maxKnowledge = limits.knowledge ?? 8
  return {
    ref: task.ref,
    title: task.title,
    decisions: decisions.slice(0, maxDecisions),
    knowledge: knowledge.slice(0, maxKnowledge),
    omitted: {
      decisions: Math.max(0, decisions.length - maxDecisions),
      knowledge: Math.max(0, knowledge.length - maxKnowledge),
    },
  }
}
