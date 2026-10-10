import type { Pool, PoolClient } from 'pg'
import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import { removeAttachments } from '@/lib/attachments'
import type { Actor } from './auth'
import { recordActivity } from './activity'
import { getLabSettings, LAB_HOME_KEY, recordHomeProject } from './lab-settings'
import { resolveAssignee } from './people'
import { resolveProject } from './project-keys'
import { fail } from './response'
import {
  defaultStage,
  findStage,
  findTags,
  isLabAdmin,
  isUuid,
  unknownStage,
  unknownTags,
  type Outcome,
  type Stage,
  type Tag,
} from './lab-admin'
import {
  conclusionMissing,
  conclusionRequired,
  isConcluding,
  nextConcludedAt,
  noteContentHash,
  parseSubjectRef,
  stageNoteHash,
  stageNoteText,
  subjectRef,
  type SubjectNoteKind,
} from './lab-shape'

/**
 * Lab subjects (docs/lab.md): `LAB-12`, on a board of curated stages, with a
 * write-up, an append-only log and curated tags. Every subject is visible to
 * every user of the instance; there is no row-level visibility.
 *
 * Ported from Croft's subjects.ts without its visibility half, on 071's
 * tables, with Cairn projects in place of Croft's lab projects.
 */

type Db = Pool | PoolClient

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

export type Person = { id: string; name: string }
export type ProjectRef = { id: string; key: string; title: string }

export type SubjectSummary = {
  id: string
  ref: string
  number: number
  title: string
  stage: Stage
  tags: Tag[]
  project: ProjectRef | null
  owner: Person | null
  conclusion: string | null
  concluded_at: string | null
  todos: { open: number; done: number }
  position: number
  actor_type: 'human' | 'agent'
  actor_id: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type Subject = SubjectSummary & { body: string | null }

export type SubjectNote = {
  id: string
  kind: SubjectNoteKind
  note: string
  actor_type: string
  actor_id: string
  created_at: string
}

const SUBJECT_SELECT = `
  select s.id, s.number, s.title, s.body, s.conclusion, s.concluded_at, s.position,
         s.actor_type, s.actor_id, s.created_at, s.updated_at, s.archived_at,
         json_build_object('id', st.id, 'name', st.name, 'category', st.category,
                           'color', st.color, 'position', st.position) as stage,
         coalesce((
           select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color, 'position', t.position)
                           order by t.position, t.name)
             from subject_tags x
             join lab_tags t on t.id = x.tag_id
            where x.subject_id = s.id
         ), '[]'::json) as tags,
         case when sp.id is null then null
              else json_build_object('id', sp.id, 'key', sp.key, 'title', sp.title)
         end as project,
         case when u.id is null then null
              else json_build_object('id', u.id, 'name', coalesce(nullif(trim(up.display_name), ''), u.email))
         end as owner,
         (select count(*) from tasks k where k.subject_id = s.id and k.status not in ('done', 'cancelled'))::int as todos_open,
         (select count(*) from tasks k where k.subject_id = s.id and k.status in ('done', 'cancelled'))::int as todos_done
    from subjects s
    join lab_stages st on st.id = s.stage_id
    left join projects sp on sp.id = s.project_id
    left join app_users u on u.id = s.owner_user_id
    left join user_profiles up on up.id = u.id`

type SubjectRow = Omit<Subject, 'ref' | 'todos'> & { todos_open: number; todos_done: number }

const toSubject = (row: SubjectRow): Subject => {
  const { todos_open, todos_done, ...rest } = row
  return { ...rest, ref: subjectRef(row.number), todos: { open: todos_open, done: todos_done } }
}

/** A board card: everything but the write-up, which can run to pages. */
const toSummary = (row: SubjectRow): SubjectSummary => {
  const { body: _body, ...summary } = toSubject(row)
  return summary
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SubjectFilters = {
  stage?: string
  category?: string
  tag?: string
  ownerId?: string
  project?: string
  q?: string
  archived?: 'exclude' | 'include' | 'only'
  limit?: number
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)
const listOf = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean)

/** The board: stages in order, then each stage's own order. */
export const listSubjects = async (filters: SubjectFilters, db: Db = pool()): Promise<SubjectSummary[]> => {
  const archived = filters.archived ?? 'exclude'
  const values: unknown[] = []
  const where: string[] = ['true']
  if (archived !== 'include') where.push(archived === 'only' ? 's.archived_at is not null' : 's.archived_at is null')
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }

  const stages = listOf(filters.stage)
  if (stages.length) {
    const v = bind(stages)
    where.push(`(st.id::text = any(${v}::text[]) or lower(st.name) = any(select lower(x) from unnest(${v}::text[]) x))`)
  }
  const categories = listOf(filters.category).map((c) => c.toLowerCase())
  if (categories.length) where.push(`st.category = any(${bind(categories)}::text[])`)

  const tags = listOf(filters.tag)
  if (tags.length) {
    const v = bind(tags)
    where.push(`exists (select 1 from subject_tags x join lab_tags t on t.id = x.tag_id
                         where x.subject_id = s.id
                           and (t.id::text = any(${v}::text[]) or t.name = any(select lower(x) from unnest(${v}::text[]) x)))`)
  }
  const projects = listOf(filters.project)
  if (projects.length) {
    const named = projects.filter((p) => p.toLowerCase() !== 'none')
    const either: string[] = []
    if (named.length < projects.length) either.push('s.project_id is null')
    if (named.length) {
      const v = bind(named)
      either.push(`(sp.id::text = any(${v}::text[]) or sp.key = any(select upper(x) from unnest(${v}::text[]) x))`)
    }
    where.push(`(${either.join(' or ')})`)
  }
  if (filters.ownerId) where.push(`s.owner_user_id = ${bind(filters.ownerId)}::uuid`)
  if (filters.q) {
    const q = bind(filters.q)
    const like = bind(`%${escapeLike(filters.q)}%`)
    where.push(`(s.search_vector @@ websearch_to_tsquery('english', ${q}) or s.title ilike ${like})`)
  }

  const result = await db.query(
    `${SUBJECT_SELECT}
      where ${where.join(' and ')}
      order by st.position, s.position, s.number
      limit ${bind(filters.limit ?? 200)}`,
    values,
  )
  return rows<SubjectRow>(result).map(toSummary)
}

/** The stage, tag and project names a list filter used that match nothing, for a readable refusal. */
export const unknownListFilters = async (filters: SubjectFilters): Promise<Response | null> => {
  for (const stage of listOf(filters.stage)) {
    if (!(await findStage(stage))) return unknownStage(stage)
  }
  const tags = listOf(filters.tag)
  if (tags.length) {
    const { unknown } = await findTags(tags)
    if (unknown.length) return unknownTags(unknown)
  }
  for (const project of listOf(filters.project)) {
    if (project.toLowerCase() === 'none') continue
    if (!(await resolveProject(project))) {
      return fail('validation_failed', `No project ${project}.`, { field: 'project' })
    }
  }
  return null
}

const getSubjectWhere = async (where: string, value: unknown, db: Db = pool()): Promise<Subject | null> => {
  const row = rows<SubjectRow>(await db.query(`${SUBJECT_SELECT} where ${where}`, [value]))[0]
  return row ? toSubject(row) : null
}

export const getSubjectById = (id: string, db: Db = pool()) =>
  isUuid(id) ? getSubjectWhere('s.id = $1', id, db) : Promise.resolve(null)

export const getSubjectByNumber = (number: number, db: Db = pool()) => getSubjectWhere('s.number = $1', number, db)

/** `LAB-12`, `lab-12`, `12` or the uuid: the choke point every `/subjects/[ref]` route resolves through. */
export const resolveSubject = async (raw: string): Promise<Subject | null> => {
  const value = (() => {
    try {
      return decodeURIComponent(raw).trim()
    } catch {
      return raw.trim()
    }
  })()
  if (isUuid(value)) return getSubjectById(value)
  const number = parseSubjectRef(value)
  return number === null ? null : getSubjectByNumber(number)
}

export const noSuchSubject = (raw: string) =>
  fail('not_found', `No subject ${raw}. Subjects are addressed as LAB-12.`)

const reloadSubject = async (id: string, db: Db = pool()): Promise<Subject> => {
  const subject = await getSubjectById(id, db)
  if (!subject) throw new Error(`subject ${id} vanished after a write`)
  return subject
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `undefined` → the caller's human; `null` → nobody; anything else → that person. */
const resolveOwner = async (owner: string | null | undefined, actor: Actor): Promise<Outcome<string | null>> => {
  if (owner === null) return { ok: true, value: null }
  const person = await resolveAssignee(owner ?? 'me', actor.userId)
  return person.ok
    ? { ok: true, value: person.person.id }
    : { ok: false, response: fail(person.code === 'not_found' ? 'validation_failed' : person.code, person.error, { field: 'owner' }) }
}

/** `undefined` → leave it; `null` → none; anything else → that live project, or a refusal. */
const resolveSubjectProject = async (ref: string | null | undefined): Promise<Outcome<string | null | undefined>> => {
  if (ref === undefined || ref === null) return { ok: true, value: ref }
  const found = await resolveProject<{ id: string; key: string; status: string }>(ref, 'id, key, status')
  if (!found) return { ok: false, response: fail('validation_failed', `No project ${ref}.`, { field: 'project' }) }
  if (found.project.status === 'archived') {
    return {
      ok: false,
      response: fail('validation_failed', `${found.project.key} is archived; restore it first or choose another project.`, {
        field: 'project',
      }),
    }
  }
  return { ok: true, value: found.project.id }
}

const setTags = async (client: PoolClient, subjectId: string, tags: Tag[]) => {
  await client.query('delete from subject_tags where subject_id = $1 and not (tag_id = any($2::uuid[]))', [
    subjectId,
    tags.map((t) => t.id),
  ])
  if (tags.length) {
    await client.query(
      'insert into subject_tags (subject_id, tag_id) select $1, unnest($2::uuid[]) on conflict do nothing',
      [subjectId, tags.map((t) => t.id)],
    )
  }
}

/** An event about a subject: its ref and title in `data`, so a tombstone still reads. */
const subjectEvent = (
  actor: Actor,
  subject: { id: string; number: number; title: string; project_id?: string | null },
  event: string,
  data: Record<string, unknown> = {},
) => ({
  subject_id: subject.id,
  project_id: subject.project_id ?? null,
  task_id: null,
  actor_type: actor.actorType,
  actor_id: actor.actorId,
  event,
  data: { ref: subjectRef(subject.number), title: subject.title, ...data },
})

export type CreateSubjectInput = {
  title: string
  body?: string
  stage?: string
  tags?: string[]
  owner?: string | null
  project?: string | null
  conclusion?: string
  number?: number
}

export const createSubject = async (actor: Actor, input: CreateSubjectInput): Promise<Outcome<Subject>> => {
  if (input.number !== undefined && !isLabAdmin(actor)) {
    return { ok: false, response: fail('forbidden', 'Only an administrator can choose a subject\'s number.') }
  }

  const stage = input.stage ? await findStage(input.stage) : await defaultStage()
  if (!stage) {
    return { ok: false, response: input.stage ? await unknownStage(input.stage) : fail('conflict', 'The board has no stages yet.') }
  }
  if (conclusionMissing({ stageChanging: true, conclusionTouched: true, targetCategory: stage.category, conclusion: input.conclusion })) {
    return { ok: false, response: conclusionRequired(stage) }
  }

  const { tags, unknown } = await findTags(input.tags ?? [])
  if (unknown.length) return { ok: false, response: await unknownTags(unknown) }

  const project = await resolveSubjectProject(input.project)
  if (!project.ok) return project

  const owner = await resolveOwner(input.owner, actor)
  if (!owner.ok) return owner

  let id: string
  try {
    id = await transaction(async (client) => {
      const inserted = await client.query(
        `insert into subjects
           (number, title, body, stage_id, owner_user_id, project_id, conclusion, concluded_at, position, actor_type, actor_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 (select coalesce(max(position) + 1, 0) from subjects where stage_id = $4),
                 $9, $10)
         returning id, number`,
        [
          input.number ?? null,
          input.title,
          input.body ?? null,
          stage.id,
          owner.value,
          project.value ?? null,
          input.conclusion ?? null,
          isConcluding(stage.category) ? new Date().toISOString() : null,
          actor.actorType,
          actor.actorId,
        ],
      )
      const row = inserted.rows[0] as { id: string; number: number }
      await setTags(client, row.id, tags)
      return row.id
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505' && input.number !== undefined) {
      return { ok: false, response: fail('conflict', `${subjectRef(input.number)} already exists.`, { number: input.number }) }
    }
    throw error
  }

  const subject = await reloadSubject(id)
  await recordActivity(
    [subjectEvent(actor, { ...subject, project_id: subject.project?.id }, 'subject_created', { stage: stage.name })],
    actor.userId,
    actor.host,
  )
  return { ok: true, value: subject }
}

export type UpdateSubjectInput = {
  title?: string
  body?: string | null
  stage?: string
  conclusion?: string | null
  tags?: string[]
  owner?: string | null
  project?: string | null
  position?: number
  archived?: boolean
}

/**
 * Edits a subject. A stage move writes a `stage` log note and a
 * `subject_stage_changed` event in the same transaction, so the log can
 * never disagree with the board.
 */
export const updateSubject = async (actor: Actor, subject: Subject, patch: UpdateSubjectInput): Promise<Outcome<Subject>> => {
  let target: Stage = subject.stage
  if (patch.stage !== undefined) {
    const found = await findStage(patch.stage)
    if (!found) return { ok: false, response: await unknownStage(patch.stage) }
    target = found
  }
  const stageChanging = target.id !== subject.stage.id
  const conclusion = patch.conclusion !== undefined ? patch.conclusion : subject.conclusion

  if (
    conclusionMissing({
      stageChanging,
      conclusionTouched: patch.conclusion !== undefined,
      targetCategory: target.category,
      conclusion,
    })
  ) {
    return { ok: false, response: conclusionRequired(target, subject.ref) }
  }

  let tags: Tag[] | undefined
  if (patch.tags !== undefined) {
    const found = await findTags(patch.tags)
    if (found.unknown.length) return { ok: false, response: await unknownTags(found.unknown) }
    tags = found.tags
  }

  const project = await resolveSubjectProject(patch.project)
  if (!project.ok) return project

  let ownerId: string | null | undefined
  if (patch.owner !== undefined) {
    const owner = await resolveOwner(patch.owner, actor)
    if (!owner.ok) return owner
    ownerId = owner.value
  }

  const now = new Date().toISOString()
  const set: string[] = []
  const values: unknown[] = [subject.id]
  const assign = (column: string, value: unknown) => {
    values.push(value)
    set.push(`${column} = $${values.length}`)
  }

  if (patch.title !== undefined) assign('title', patch.title)
  if (patch.body !== undefined) assign('body', patch.body)
  if (patch.conclusion !== undefined) assign('conclusion', patch.conclusion)
  if (ownerId !== undefined) assign('owner_user_id', ownerId)
  if (project.value !== undefined) assign('project_id', project.value)

  let archiving: 'subject_archived' | 'subject_restored' | null = null
  if (patch.archived === true && !subject.archived_at) {
    assign('archived_at', now)
    archiving = 'subject_archived'
  }
  if (patch.archived === false && subject.archived_at) {
    assign('archived_at', null)
    archiving = 'subject_restored'
  }
  if (stageChanging) {
    assign('stage_id', target.id)
    const concludedAt = nextConcludedAt({
      fromCategory: subject.stage.category,
      toCategory: target.category,
      concludedAt: subject.concluded_at,
      now,
    })
    if (concludedAt !== subject.concluded_at) assign('concluded_at', concludedAt)
  } else if (patch.conclusion && isConcluding(target.category) && !subject.concluded_at) {
    assign('concluded_at', now)
  }
  if (patch.position !== undefined) {
    assign('position', patch.position)
  } else if (stageChanging) {
    values.push(target.id)
    set.push(`position = (select coalesce(max(position) + 1, 0) from subjects where stage_id = $${values.length})`)
  }

  const title = patch.title ?? subject.title
  const projectId = project.value !== undefined ? project.value : (subject.project?.id ?? null)
  const events: ReturnType<typeof subjectEvent>[] = []

  await transaction(async (client) => {
    if (set.length > 0) await client.query(`update subjects set ${set.join(', ')} where id = $1`, values)
    if (tags !== undefined) {
      await setTags(client, subject.id, tags)
      if (set.length === 0) await client.query('update subjects set updated_at = now() where id = $1', [subject.id])
    }
    if (stageChanging) {
      await client.query(
        `insert into subject_notes (subject_id, kind, note, actor_type, actor_id, user_id, content_hash)
         values ($1, 'stage', $2, $3, $4, $5, $6)`,
        [
          subject.id,
          stageNoteText(subject.stage.name, target.name),
          actor.actorType,
          actor.actorId,
          actor.userId,
          stageNoteHash(subject.stage.name, target.name, now),
        ],
      )
      const event = subjectEvent(actor, { id: subject.id, number: subject.number, title, project_id: projectId }, 'subject_stage_changed', {
        from: subject.stage.name,
        to: target.name,
        category: target.category,
      })
      await client.query(
        `insert into task_activity_events (owner_user_id, subject_id, project_id, task_id, actor_type, actor_id, event, data)
         values ($1, $2, $3, null, $4, $5, $6, $7)`,
        [
          actor.userId,
          event.subject_id,
          event.project_id,
          event.actor_type,
          event.actor_id,
          event.event,
          JSON.stringify(actor.host ? { ...event.data, host: actor.host } : event.data),
        ],
      )
    }
  })

  if (archiving) events.push(subjectEvent(actor, { id: subject.id, number: subject.number, title, project_id: projectId }, archiving))
  await recordActivity(events, actor.userId, actor.host)

  return { ok: true, value: await reloadSubject(subject.id) }
}

// ---------------------------------------------------------------------------
// Deleting: never destroys task history (docs/lab.md, "Deleting a subject")
// ---------------------------------------------------------------------------

export type DeletedSubject = {
  deleted: true
  ref: string
  id: string
  todos_detached: number
  files_removed: number
}

export const canDeleteSubject = (subject: Pick<Subject, 'owner'>, actor: Pick<Actor, 'userId' | 'role'>) =>
  isLabAdmin(actor) || subject.owner?.id === actor.userId

export const deleteSubject = async (
  actor: Actor,
  subject: Subject,
  options: { detach: boolean },
): Promise<Outcome<DeletedSubject>> => {
  if (!canDeleteSubject(subject, actor)) {
    return { ok: false, response: fail('forbidden', `Only the owner of ${subject.ref} or an administrator can delete it.`) }
  }

  const counts = rows<{ todos: number; open: number }>(
    await pool().query(
      `select count(*)::int as todos, count(*) filter (where status not in ('done', 'cancelled'))::int as open
         from tasks where subject_id = $1`,
      [subject.id],
    ),
  )[0] ?? { todos: 0, open: 0 }

  if (counts.todos > 0 && !options.detach) {
    return {
      ok: false,
      response: fail(
        'subject_has_todos',
        `${subject.ref} has ${counts.todos} todo${counts.todos === 1 ? '' : 's'} (${counts.open} open). Deleting it never ` +
          `deletes tasks: archive it instead, or detach them with todos=detach (each keeps its project, history and ` +
          `a note saying it was a todo of ${subject.ref}).`,
        counts,
      ),
    }
  }

  const files = rows<{ storage_path: string }>(
    await pool().query('select storage_path from subject_attachments where subject_id = $1', [subject.id]),
  ).map((f) => f.storage_path)
  // Objects first: a failed row delete leaves a recoverable inconsistency,
  // a deleted row with a live object is an unreferenced leak.
  if (files.length > 0) await removeAttachments(files)

  const detached = await transaction(async (client) => {
    const { rows: todos } = await client.query<{ id: string }>(
      'select id from tasks where subject_id = $1 for update',
      [subject.id],
    )
    const note = `Was a todo of ${subject.ref} (${subject.title}), which was deleted.`
    for (const todo of todos) {
      await client.query(
        `insert into task_notes (task_id, kind, note, actor_type, actor_id, content_hash)
         values ($1, 'note', $2, $3, $4, $5)
         on conflict do nothing`,
        [todo.id, note, actor.actorType, actor.actorId, noteContentHash('note', note)],
      )
    }
    await client.query('update tasks set subject_id = null where subject_id = $1', [subject.id])
    await client.query('delete from subjects where id = $1', [subject.id])
    return todos.length
  })

  await recordActivity(
    [subjectEvent(actor, { ...subject, project_id: subject.project?.id }, 'subject_deleted', { todos_detached: detached })],
    actor.userId,
    actor.host,
  )

  return {
    ok: true,
    value: { deleted: true, ref: subject.ref, id: subject.id, todos_detached: detached, files_removed: files.length },
  }
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

const NOTE_COLUMNS = 'id, kind, note, actor_type, actor_id, created_at'

/** Newest first, like a task's notes. */
export const listSubjectNotes = async (
  subjectId: string,
  options: { kinds?: string[]; limit?: number } = {},
): Promise<SubjectNote[]> => {
  const result = await pool().query(
    `select ${NOTE_COLUMNS} from subject_notes
      where subject_id = $1 and ($2::text[] is null or kind = any($2::text[]))
      order by created_at desc, id desc
      limit $3`,
    [subjectId, options.kinds?.length ? options.kinds : null, options.limit ?? 200],
  )
  return rows<SubjectNote>(result)
}

/** Appends to the log. Idempotent on (subject, kind + text): a retry writes nothing. */
export const addSubjectNote = async (
  actor: Actor,
  subjectId: string,
  input: { note: string; kind: SubjectNoteKind },
  contentHash = noteContentHash(input.kind, input.note),
  db: Db = pool(),
): Promise<{ note: SubjectNote | null; duplicate: boolean }> => {
  const result = await db.query(
    `insert into subject_notes (subject_id, kind, note, actor_type, actor_id, user_id, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (subject_id, content_hash) do nothing
     returning ${NOTE_COLUMNS}`,
    [subjectId, input.kind, input.note, actor.actorType, actor.actorId, actor.userId, contentHash],
  )
  const note = rows<SubjectNote>(result)[0] ?? null
  return { note, duplicate: note === null }
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

export type Todo = {
  id: string
  ref: string
  number: number
  title: string
  status: string
  priority: string
  type: string
  claimed_by: string | null
  assignee: Person | null
  updated_at: string
}

/** A subject's todos and their sub-tasks: open first, then by position and number. */
export const listSubjectTodos = async (subjectId: string, statuses: string[] = []) => {
  const result = await pool().query(
    `with recursive tree as (
       select id from tasks where subject_id = $1
       union
       select t.id from tasks t join tree on t.parent_id = tree.id
     )
     select t.id, t.number, p.key, t.title, t.status, t.priority, t.type, t.claimed_by,
            t.assignee_user_id, t.parent_id, t.subject_id,
            t.handoff_tracker, t.handoff_ref, t.handoff_url, t.handoff_status, t.handoff_synced_at, t.updated_at
       from tasks t
       join tree using (id)
       join projects p on p.id = t.project_id
      where ($2::text[] is null or t.status = any($2::text[]))
      order by (t.status in ('done', 'cancelled')), t.position, t.number`,
    [subjectId, statuses.length ? statuses : null],
  )
  return rows<Record<string, unknown> & { key: string; number: number }>(result).map(({ key, ...todo }) => ({
    ...todo,
    ref: `${key}-${todo.number}`,
  }))
}

/**
 * The project a new todo of `subject` is filed in: the subject's own project
 * when it has a live one, else the instance's Lab home project — created on
 * first use as `LT`, unless that key is taken by something else, which is
 * refused rather than guessed at.
 */
export const todoProjectFor = async (
  actor: Actor,
  subject: Pick<Subject, 'project'>,
): Promise<Outcome<{ id: string; key: string; status: string }>> => {
  if (subject.project) {
    const found = await resolveProject<{ id: string; key: string; status: string }>(subject.project.id, 'id, key, status')
    if (found && found.project.status !== 'archived') return { ok: true, value: found.project }
  }

  const settings = await getLabSettings()
  if (settings.home_project) {
    const found = await resolveProject<{ id: string; key: string; status: string }>(settings.home_project.id, 'id, key, status')
    if (found?.project.status === 'archived') {
      return {
        ok: false,
        response: fail(
          'conflict',
          `The Lab's home project for todos, ${found.project.key}, is archived. An administrator chooses another ` +
            `(PUT /api/v1/lab/settings {"homeProject": "<key>"}) or restores ${found.project.key}; or give the ` +
            `subject a project of its own.`,
          { key: found.project.key, projectStatus: 'archived' },
        ),
      }
    }
    if (found) return { ok: true, value: found.project }
  }

  const taken = await resolveProject<{ id: string; key: string; status: string; description: string | null }>(
    LAB_HOME_KEY,
    'id, key, status, description',
  )
  if (taken) {
    return {
      ok: false,
      response: fail(
        'conflict',
        `The Lab has no home project for todos, and ${LAB_HOME_KEY} is already a project. An administrator ` +
          `chooses one: PUT /api/v1/lab/settings {"homeProject": "<key>"}.`,
        { key: LAB_HOME_KEY },
      ),
    }
  }

  const created = rows<{ id: string; key: string; status: string }>(
    await pool().query(
      `insert into projects (owner_user_id, key, title, description)
       values ($1, $2, 'Lab todos', 'Todos of Lab subjects that have no project of their own.')
       on conflict do nothing
       returning id, key, status`,
      [actor.userId, LAB_HOME_KEY],
    ),
  )[0]
  if (created) {
    await recordActivity(
      [
        {
          project_id: created.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          event: 'project_created',
          data: { key: LAB_HOME_KEY, title: 'Lab todos' },
        },
      ],
      actor.userId,
      actor.host,
    )
  }
  const raced = created ?? (await resolveProject<{ id: string; key: string; status: string }>(LAB_HOME_KEY, 'id, key, status'))?.project
  if (!raced) throw new Error('the Lab home project could not be created')
  const recorded = await recordHomeProject(raced.id)
  const home = await resolveProject<{ id: string; key: string; status: string }>(recorded, 'id, key, status')
  return { ok: true, value: home?.project ?? raced }
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

const clip = (text: string, ref: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toUpperCase().indexOf(ref.toUpperCase())
  if (at < 0) return flat.slice(0, 160)
  const start = Math.max(0, at - 70)
  return `${start > 0 ? '…' : ''}${flat.slice(start, at + ref.length + 70)}${at + ref.length + 70 < flat.length ? '…' : ''}`
}

/** The tasks whose text names this subject, newest first. */
export const subjectMentions = async (subject: Pick<Subject, 'id' | 'ref'>, limit = 20) => {
  const result = await pool().query(
    `select m.source, m.created_at as at, p.key, t.number, t.title, t.status,
            case m.source
              when 'note' then n.note
              when 'comment' then c.content
              when 'description' then t.description
              else t.resolution
            end as text,
            count(*) over () as total
       from subject_mentions m
       join tasks t on t.id = m.source_task_id
       join projects p on p.id = t.project_id
       left join task_notes n on n.id = m.note_id
       left join task_comments c on c.id = m.comment_id
      where m.target_subject_id = $1
      order by m.created_at desc
      limit $2`,
    [subject.id, limit],
  )
  const found = rows<{ source: string; at: string; key: string; number: number; title: string; status: string; text: string | null; total: string }>(result)
  return {
    total: Number(found[0]?.total ?? 0),
    items: found.map((m) => ({
      ref: `${m.key}-${m.number}`,
      title: m.title,
      status: m.status,
      source: m.source,
      excerpt: clip(m.text ?? '', subject.ref),
      at: m.at,
    })),
  }
}

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

export type LabBrief = {
  stages: (Stage & { count: number })[]
  mine: SubjectSummary[]
}

/** How full each stage is, and at most three live subjects the caller's human owns — active before planned. */
export const labBrief = async (userId: string): Promise<LabBrief> => {
  const stages = rows<Stage & { count: number }>(
    await pool().query(
      `select st.id, st.name, st.category, st.color, st.position, count(s.id)::int as count
         from lab_stages st
         left join subjects s on s.stage_id = st.id and s.archived_at is null
        group by st.id
        order by st.position, st.name`,
    ),
  )
  const mine = rows<SubjectRow>(
    await pool().query(
      `${SUBJECT_SELECT}
        where s.archived_at is null
          and s.owner_user_id = $1
          and st.category in ('active', 'planned')
        order by (st.category = 'active') desc, s.updated_at desc
        limit 3`,
      [userId],
    ),
  ).map(toSummary)
  return { stages, mine }
}

/** Used by search: the subject a `LAB-12` query names, if it exists. */
export const subjectByNumber = (number: number) => getSubjectByNumber(number)
