import type { PoolClient } from 'pg'
import { admin, normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import { normalisePath } from './files'
import type { Actor } from './auth'
import { normalizeSlugRef, slugify, type KnowledgeCreate, type KnowledgeUpdate } from '@/schemas/knowledge'
import { findTask } from './tasks'
import { projectIdForFormerKey } from './project-keys'

/**
 * Knowledge: the durable half of memory.
 *
 * A task answers "what did we do about X". This answers "what do we know about
 * X" — the infra note, the convention, the gotcha that outlives every task it
 * was learned in. It belongs to no task, and usually to no single project,
 * which is why nothing in Cairn could hold it until now.
 *
 * Knowledge is shared workspace data. Legacy owner ids remain attribution
 * metadata for existing rows; they are not an authorization boundary.
 */

const COLUMNS =
  'id, slug, title, body, labels, verified_at, superseded_by, actor_type, actor_id, ' +
  'source_task_id, source_session_id, source_session_ref, created_at, updated_at'

export type KnowledgeRow = {
  id: string
  slug: string
  title: string
  body: string
  labels: string[]
  verified_at: string | null
  superseded_by: string | null
  actor_type: string
  actor_id: string | null
  source_task_id: string | null
  source_session_id: string | null
  /** The session that wrote it, as the caller named it (064). */
  source_session_ref?: string | null
  created_at: string
  updated_at: string
  projects?: string[]
  entities?: string[]
  /** How specifically this applies here. Narrower wins when both are relevant. */
  scope?: 'project' | 'entity' | 'global'
}

/** Entity keys -> ids. Unknown keys are reported, never invented. */
const resolveEntities = async (_userId: string, keys: string[]) => {
  if (keys.length === 0) return { ids: [] as string[], missing: [] as string[] }

  const wanted = [...new Set(keys.map((k) => k.toLowerCase()))]
  const { data, error } = await admin()
    .from('entities')
    .select('id, key')
    .in('key', wanted)
  if (error) throw new Error(error.message)

  const found = new Map((data ?? []).map((e) => [e.key as string, e.id as string]))
  return {
    ids: wanted.map((k) => found.get(k)).filter((id): id is string => Boolean(id)),
    missing: wanted.filter((k) => !found.has(k)),
  }
}

/** Project keys -> ids. Unknown keys are reported, never ignored. */
const resolveProjects = async (_userId: string, keys: string[]) => {
  if (keys.length === 0) return { ids: [] as string[], missing: [] as string[] }

  const wanted = [...new Set(keys.map((k) => k.toUpperCase()))]
  const { data, error } = await admin()
    .from('projects')
    .select('id, key')
    .in('key', wanted)

  if (error) throw new Error(error.message)

  const found = new Map((data ?? []).map((p) => [p.key as string, p.id as string]))

  // A key that is no longer current is still a key somebody wrote down. The
  // task paths resolve renames through `project_former_keys` (tasks.ts:69,
  // search.ts:180) and this did not, so `cairn know --project OLDKEY` went on
  // returning nothing at all — defeating the reason former keys are kept.
  for (const key of wanted) {
    if (found.has(key)) continue
    const viaFormer = await projectIdForFormerKey(_userId, key)
    if (viaFormer) found.set(key, viaFormer)
  }

  return {
    ids: wanted.map((k) => found.get(k)).filter((id): id is string => Boolean(id)),
    missing: wanted.filter((k) => !found.has(k)),
  }
}

/** The project keys a row is scoped to. Empty means global. */
const projectKeysFor = async (ids: string[]): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out

  const { data, error } = await admin()
    .from('knowledge_projects')
    .select('knowledge_id, project:projects(key)')
    .in('knowledge_id', ids)

  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    const embedded = row.project as unknown as { key: string } | { key: string }[] | null
    const key = Array.isArray(embedded) ? embedded[0]?.key : embedded?.key
    if (!key) continue
    const list = out.get(row.knowledge_id as string) ?? []
    list.push(key)
    out.set(row.knowledge_id as string, list)
  }
  for (const [, list] of out) list.sort()
  return out
}

/** The entity keys a row is scoped to. */
const entityKeysFor = async (ids: string[]): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out

  const { data, error } = await admin()
    .from('knowledge_entities')
    .select('knowledge_id, entity:entities(key)')
    .in('knowledge_id', ids)
  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    const embedded = row.entity as unknown as { key: string } | { key: string }[] | null
    const key = Array.isArray(embedded) ? embedded[0]?.key : embedded?.key
    if (!key) continue
    out.set(row.knowledge_id as string, [...(out.get(row.knowledge_id as string) ?? []), key])
  }
  for (const [, list] of out) list.sort()
  return out
}

const withProjects = async (rows: KnowledgeRow[]): Promise<KnowledgeRow[]> => {
  const ids = rows.map((r) => r.id)
  const [projects, entities] = await Promise.all([projectKeysFor(ids), entityKeysFor(ids)])
  return rows.map((r) => ({
    ...r,
    projects: projects.get(r.id) ?? [],
    entities: entities.get(r.id) ?? [],
  }))
}

/** Entity keys a project belongs to — the middle scope between it and global. */
export const entitiesForProject = async (_userId: string, key: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('project_entities')
    .select('entity:entities!inner(key), project:projects!inner(key)')
    .eq('projects.key', key.toUpperCase())
  if (error) throw new Error(error.message)

  const keys = (data ?? [])
    .map((row) => {
      const e = row.entity as unknown as { key: string } | { key: string }[] | null
      return Array.isArray(e) ? e[0]?.key : e?.key
    })
    .filter((k): k is string => Boolean(k))
  return [...new Set(keys)].sort()
}

/**
 * How many entries there actually are, which is not how many were fetched.
 *
 * The list page asked for a page of 300 and then printed that page's length as
 * the total. The corpus was 381, so it under-reported by 81 and disagreed with
 * the map standing one click away — the kind of thing that makes a reader
 * distrust both numbers. A count is a separate, cheap query; the page size is
 * not an answer to "how much do we know".
 */
export const countKnowledge = async (
  filters: { includeSuperseded?: boolean } = {},
): Promise<number> => {
  let q = admin().from('knowledge').select('id', { count: 'exact', head: true })
  if (!filters.includeSuperseded) q = q.is('superseded_by', null)
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

export const listKnowledge = async (
  userId: string,
  filters: {
    project?: string
    entity?: string
    label?: string
    limit: number
    includeSuperseded?: boolean
  },
): Promise<KnowledgeRow[]> => {
  // Narrowing by entity happens here, in the query, for the same reason the
  // project narrowing does: a filter applied to an already-limited page only
  // reorders that page, and looks correct until the corpus outgrows the limit.
  let filterToEntity: string[] | null = null
  if (filters.entity) {
    const { data, error } = await admin()
      .from('knowledge_entities')
      .select('knowledge_id, entity:entities!inner(key)')
      .eq('entities.key', filters.entity.toLowerCase())
    if (error) throw new Error(error.message)

    filterToEntity = (data ?? []).map((r) => r.knowledge_id as string)
    if (filterToEntity.length === 0) return []
  }

  const base = () => {
    let q = admin()
      .from('knowledge')
      .select(COLUMNS)
      .order('updated_at', { ascending: false })

    if (filters.label) q = q.contains('labels', [filters.label])
    if (!filters.includeSuperseded) q = q.is('superseded_by', null)
    if (filterToEntity) q = q.in('id', filterToEntity)
    return q
  }

  if (!filters.project) {
    const { data, error } = await base().limit(filters.limit)
    if (error) throw new Error(error.message)
    return withProjects((data ?? []) as unknown as KnowledgeRow[])
  }

  // What applies here is three things: what was filed against this project,
  // what was filed against a grouping it belongs to, and what is true
  // everywhere. An infra gotcha applies here; so does a convention that holds
  // across a business, if this project belongs to it.
  const { ids, missing } = await resolveProjects(userId, [filters.project])
  // An empty list used to be the answer for a key that does not exist, so a
  // typo was indistinguishable from a project nobody has learned anything
  // about — and it took the global facts down with it. The write path has
  // always said so; the read path swallowed it.
  if (missing.length > 0) throw new Error(`No such project: ${missing.join(', ')}`)
  if (ids.length === 0) return []

  const [scoped, viaEntities, globals] = await Promise.all([
    admin().from('knowledge_projects').select('knowledge_id').eq('project_id', ids[0]),
    knowledgeForEntitiesOf(userId, filters.project),
    globalIds(userId),
  ])
  if (scoped.error) throw new Error(scoped.error.message)

  const projectIds = (scoped.data ?? []).map((r) => r.knowledge_id as string)
  const entityIds = viaEntities.filter((id) => !projectIds.includes(id))
  const globalOnly = globals.filter(
    (id) => !projectIds.includes(id) && !entityIds.includes(id),
  )

  // Narrower wins, and the narrowing has to survive the LIMIT. Sorting a page
  // after fetching it only reorders that page: asking for twelve rows returned
  // the twelve most recent of any scope, so a global fact could crowd out a
  // fact about the project you are standing in. Each scope is therefore its
  // own query, filling what the narrower one left.
  const rows: KnowledgeRow[] = []
  const tiers: [string[], KnowledgeRow['scope']][] = [
    [projectIds, 'project'],
    [entityIds, 'entity'],
    [globalOnly, 'global'],
  ]

  for (const [ids_, scope] of tiers) {
    const remaining = filters.limit - rows.length
    if (remaining <= 0 || ids_.length === 0) continue

    const { data, error } = await base().in('id', ids_).limit(remaining)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as unknown as KnowledgeRow[]) rows.push({ ...row, scope })
  }

  // withProjects rebuilds the objects, so carry the scope across by id rather
  // than by position — a reorder there would silently mislabel every row.
  const scopeById = new Map(rows.map((row) => [row.id, row.scope]))
  const withLinks = await withProjects(rows)
  return withLinks.map((row) => ({ ...row, scope: scopeById.get(row.id) }))
}

/** Knowledge scoped to any entity the given project belongs to. */
const knowledgeForEntitiesOf = async (userId: string, projectKey: string): Promise<string[]> => {
  const keys = await entitiesForProject(userId, projectKey)
  if (keys.length === 0) return []

  const { data, error } = await admin()
    .from('knowledge_entities')
    .select('knowledge_id, entity:entities!inner(key)')
    .in('entities.key', keys)
  if (error) throw new Error(error.message)

  return (data ?? []).map((r) => r.knowledge_id as string)
}

/**
 * Rows scoped to nothing at all — true everywhere.
 *
 * Both link tables have to be checked. Checking only projects made every
 * entity-scoped fact global as well, so scoping a fact to one entity left it
 * showing up on every unrelated project exactly as before — the change looked
 * applied and did nothing.
 */
const globalIds = async (_userId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('id, knowledge_projects(knowledge_id), knowledge_entities(knowledge_id)')
  if (error) throw new Error(error.message)

  return (data ?? [])
    .filter(
      (r) =>
        ((r.knowledge_projects as unknown[]) ?? []).length === 0 &&
        ((r.knowledge_entities as unknown[]) ?? []).length === 0,
    )
    .map((r) => r.id as string)
}

export const getKnowledge = async (_userId: string, slug: string): Promise<KnowledgeRow | null> => {
  // Normalised, so a reference written `[[a_b_c]]` finds `a-b-c`. Lookup only:
  // what is stored is still exactly what the author chose.
  const { data, error } = await admin()
    .from('knowledge')
    .select(COLUMNS)
    .eq('slug', normalizeSlugRef(slug))
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  const [row] = await withProjects([data as unknown as KnowledgeRow])
  return row ?? null
}

/**
 * Where a fact came from, filled in from the request rather than asked for
 * (CAIRN-289).
 *
 * 0 of 425 entries carried a session or a task: `cairn learn` never sent
 * either and nobody passed `--task`, so Mac and Clawdius writes, and the work
 * a fact came out of, could not be told apart — and staleness, which follows
 * a fact's source to the files that work touched, had nothing to follow.
 *
 * The session arrives on every request as `X-Cairn-Session`. It is stored as
 * given (`source_session_ref`), because the `sessions` row it names is
 * normally written at session END, after the fact was learned: the foreign
 * key is filled only when the row already exists, and readers resolve the
 * ref through `sessions.external_id` otherwise. Resolving it later by
 * updating the fact is not an option — every UPDATE of knowledge fires
 * knowledge_touch and would stamp it as just edited.
 *
 * The task is the one this session holds, when it holds exactly one. Two held
 * tasks is a guess, and a wrong source is worse than none; `--task` settles it.
 */
export const inferProvenance = async (
  session: string | null,
  given: { sessionId: string | null; taskId: string | null },
): Promise<{ sessionId: string | null; taskId: string | null }> => {
  if (!session) return given
  const [sessionRow, held] = await Promise.all([
    given.sessionId
      ? Promise.resolve(null)
      : pool().query<{ id: string }>(
          'select id from sessions where external_id = $1 order by created_at limit 1',
          [session],
        ),
    given.taskId
      ? Promise.resolve(null)
      : pool().query<{ id: string }>(
          `select id from tasks
            where claimed_session = $1 and claimed_by is not null
              and status not in ('done', 'cancelled')
            limit 2`,
          [session],
        ),
  ])
  return {
    sessionId: given.sessionId ?? sessionRow?.rows[0]?.id ?? null,
    taskId: given.taskId ?? (held?.rows.length === 1 ? (held.rows[0]?.id ?? null) : null),
  }
}

export const createKnowledge = async (actor: Actor, input: KnowledgeCreate) => {
  const slug = input.slug ?? slugify(input.title)
  if (!slug) throw new Error('Could not derive a slug from that title; pass --slug.')

  const { ids, missing } = await resolveProjects(actor.userId, input.projects)
  if (missing.length > 0) throw new Error(`No such project: ${missing.join(', ')}`)

  const entities = await resolveEntities(actor.userId, input.entities)
  if (entities.missing.length > 0) {
    throw new Error(`No such entity: ${entities.missing.join(', ')}`)
  }

  let sourceTaskId: string | null = null
  if (input.sourceTaskRef) {
    const task = await findTask(actor, input.sourceTaskRef, 'id')
    if (!task) throw new Error(`No task ${input.sourceTaskRef}.`)
    sourceTaskId = task.id
  }
  const provenance = await inferProvenance(actor.sessionId, {
    sessionId: input.sourceSessionId ?? null,
    taskId: sourceTaskId,
  })

  let data: KnowledgeRow
  try {
    data = await transaction(async (client) => {
      const inserted = await client.query(
        `insert into knowledge
          (owner_user_id, slug, title, body, labels, actor_type, actor_id,
           source_task_id, source_session_id, source_session_ref, verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [actor.userId, slug, input.title, input.body, input.labels, actor.actorType,
          actor.actorId, provenance.taskId, provenance.sessionId, actor.sessionId,
          input.verified ? new Date().toISOString() : null],
      )
      const row = inserted.rows[0] as KnowledgeRow
      if (ids.length > 0) {
        await client.query(
          `insert into knowledge_projects (knowledge_id, project_id)
           select $1, unnest($2::uuid[])`, [row.id, ids],
        )
      }
      if (entities.ids.length > 0) {
        await client.query(
          `insert into knowledge_entities (knowledge_id, entity_id)
           select $1, unnest($2::uuid[])`, [row.id, entities.ids],
        )
      }
      await replaceExplicitFiles(client, row.id, input.files)
      return normalizeDatabaseValue(row) as KnowledgeRow
    })
  } catch (error) {
    const candidate = error as { code?: string; message?: string }
    if (candidate.code === '23505') throw new Error(`Knowledge "${slug}" already exists.`)
    throw error
  }

  const [row] = await withProjects([data as unknown as KnowledgeRow])
  return row
}

/**
 * The files an entry is explicitly about (CAIRN-269). Only this origin is the
 * caller's: paths the body names and files the source work touched are kept by
 * the `knowledge_files_sync` trigger, so they cannot drift from the text.
 */
const replaceExplicitFiles = async (client: PoolClient, knowledgeId: string, files: string[] | undefined) => {
  if (files === undefined) return
  await client.query(`delete from knowledge_files where knowledge_id = $1 and origin = 'explicit'`, [knowledgeId])
  const paths = [...new Set(files.map((f) => normalisePath(f)).filter(Boolean))]
  if (paths.length === 0) return
  await client.query(
    `insert into knowledge_files (knowledge_id, path, origin)
     select $1, unnest($2::text[]), 'explicit' on conflict do nothing`,
    [knowledgeId, paths],
  )
}

/** Which files each entry is linked to, from every origin. */
export const linkedFiles = async (ids: string[]): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const { rows } = await pool().query(
    `select knowledge_id, array_agg(distinct path order by path) as paths
       from knowledge_files where knowledge_id = any($1::uuid[]) group by knowledge_id`,
    [ids],
  )
  for (const row of rows) out.set(row.knowledge_id as string, row.paths as string[])
  return out
}

type RevisionChange = 'relearned' | 'rescoped' | 'superseded' | 'reinstated'

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a)
  return left.size === new Set(b).size && b.every((v) => left.has(v))
}

/**
 * Keep the version an edit is about to replace (CAIRN-266).
 *
 * Decided by comparing values, not by which fields the patch carried: the
 * browser sends every field on every save, and a save that changes nothing is
 * not a new version. A `verify` alone is not one either — it confirms the text,
 * it does not change it.
 *
 * Reads the live row `for update`, so two edits racing each other each keep the
 * version they actually replaced, and number it without colliding.
 */
const recordRevision = async (
  client: PoolClient,
  actor: Actor,
  knowledgeId: string,
  fields: Record<string, unknown>,
  projectIds: string[] | undefined,
  entityIds: string[] | undefined,
  reason: string | undefined,
) => {
  const { rows } = await client.query(
    `select k.title, k.body, k.labels, k.verified_at, k.superseded_by,
            coalesce((select array_agg(kp.project_id::text) from knowledge_projects kp
                       where kp.knowledge_id = k.id), '{}') as project_ids,
            coalesce((select array_agg(p.key order by p.key) from knowledge_projects kp
                       join projects p on p.id = kp.project_id
                      where kp.knowledge_id = k.id), '{}') as project_keys,
            coalesce((select array_agg(ke.entity_id::text) from knowledge_entities ke
                       where ke.knowledge_id = k.id), '{}') as entity_ids,
            coalesce((select array_agg(e.key order by e.key) from knowledge_entities ke
                       join entities e on e.id = ke.entity_id
                      where ke.knowledge_id = k.id), '{}') as entity_keys
       from knowledge k
      where k.id = $1
        for update of k`,
    [knowledgeId],
  )
  const live = rows[0] as
    | {
        title: string
        body: string
        labels: string[]
        verified_at: string | null
        superseded_by: string | null
        project_ids: string[]
        project_keys: string[]
        entity_ids: string[]
        entity_keys: string[]
      }
    | undefined
  if (!live) return

  const contentChanged =
    (fields.title !== undefined && fields.title !== live.title) ||
    (fields.body !== undefined && fields.body !== live.body) ||
    (fields.labels !== undefined && !sameSet(fields.labels as string[], live.labels))
  const scopeChanged =
    (projectIds !== undefined && !sameSet(projectIds, live.project_ids)) ||
    (entityIds !== undefined && !sameSet(entityIds, live.entity_ids))
  const supersession = fields.superseded_by !== undefined && fields.superseded_by !== live.superseded_by

  let change: RevisionChange | null = null
  if (supersession) change = fields.superseded_by === null ? 'reinstated' : 'superseded'
  else if (contentChanged) change = 'relearned'
  else if (scopeChanged) change = 'rescoped'
  if (!change) return

  await client.query(
    `insert into knowledge_revisions
       (knowledge_id, revision, title, body, labels, projects, entities, verified_at,
        superseded_by, change, edited_by_type, edited_by, edited_session, reason)
     select $1, coalesce(max(revision), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       from knowledge_revisions where knowledge_id = $1`,
    [knowledgeId, live.title, live.body, live.labels, live.project_keys, live.entity_keys,
      live.verified_at, live.superseded_by, change, actor.actorType, actor.actorId,
      actor.sessionId, reason ?? null],
  )
}

export type KnowledgeRevision = {
  revision: number
  title: string
  body: string
  labels: string[]
  projects: string[]
  entities: string[]
  verified_at: string | null
  superseded_by: string | null
  change: RevisionChange
  edited_by_type: 'human' | 'agent'
  edited_by: string | null
  reason: string | null
  edited_at: string
}

/** Every replaced version of an entry, newest first. Null when there is no such entry. */
export const knowledgeRevisions = async (
  userId: string,
  slug: string,
): Promise<{ entry: KnowledgeRow; revisions: KnowledgeRevision[] } | null> => {
  const entry = await getKnowledge(userId, slug)
  if (!entry) return null

  const { data, error } = await admin()
    .from('knowledge_revisions')
    .select(
      'revision, title, body, labels, projects, entities, verified_at, superseded_by, ' +
        'change, edited_by_type, edited_by, reason, edited_at',
    )
    .eq('knowledge_id', entry.id)
    .order('revision', { ascending: false })
  if (error) throw new Error(error.message)

  return { entry, revisions: (data ?? []) as unknown as KnowledgeRevision[] }
}

export const updateKnowledge = async (actor: Actor, slug: string, patch: KnowledgeUpdate) => {
  const existing = await getKnowledge(actor.userId, slug)
  if (!existing) return null

  const fields: Record<string, unknown> = {}
  if (patch.title !== undefined) fields.title = patch.title
  if (patch.body !== undefined) fields.body = patch.body
  if (patch.labels !== undefined) fields.labels = patch.labels
  if (patch.verified !== undefined) {
    fields.verified_at = patch.verified ? new Date().toISOString() : null
  }

  if (patch.supersededBy !== undefined) {
    if (patch.supersededBy === null) {
      fields.superseded_by = null
    } else {
      const replacement = await getKnowledge(actor.userId, patch.supersededBy)
      if (!replacement) throw new Error(`No knowledge "${patch.supersededBy}".`)
      if (replacement.id === existing.id) throw new Error('Knowledge cannot supersede itself.')
      fields.superseded_by = replacement.id
    }
  }

  let entityIds: string[] | undefined
  if (patch.entities !== undefined) {
    const entities = await resolveEntities(actor.userId, patch.entities)
    if (entities.missing.length > 0) {
      throw new Error(`No such entity: ${entities.missing.join(', ')}`)
    }
    entityIds = entities.ids
  }

  // Project links are replaced wholesale when given: an explicit list is a
  // statement about where this applies, not an addition to it.
  let projectIds: string[] | undefined
  if (patch.projects !== undefined) {
    const { ids, missing } = await resolveProjects(actor.userId, patch.projects)
    if (missing.length > 0) throw new Error(`No such project: ${missing.join(', ')}`)
    projectIds = ids
  }

  await transaction(async (client) => {
    await recordRevision(client, actor, existing.id, fields, projectIds, entityIds, patch.reason)

    if (Object.keys(fields).length > 0) {
      const columns = Object.keys(fields)
      const allowed = new Set(['title', 'body', 'labels', 'verified_at', 'superseded_by'])
      if (columns.some((column) => !allowed.has(column))) throw new Error('Unsafe knowledge update field')
      const values = Object.values(fields)
      const assignments = columns.map((column, index) => `"${column}" = $${index + 1}`).join(', ')
      const result = await client.query(
        `update knowledge set ${assignments} where id = $${values.length + 1}`,
        [...values, existing.id],
      )
      if (result.rowCount !== 1) throw new Error(`Knowledge "${slug}" changed or disappeared.`)
    }
    if (entityIds !== undefined) {
      await client.query('delete from knowledge_entities where knowledge_id = $1', [existing.id])
      if (entityIds.length > 0) {
        await client.query(
          `insert into knowledge_entities (knowledge_id, entity_id)
           select $1, unnest($2::uuid[])`, [existing.id, entityIds],
        )
      }
    }
    await replaceExplicitFiles(client, existing.id, patch.files)
    if (projectIds !== undefined) {
      await client.query('delete from knowledge_projects where knowledge_id = $1', [existing.id])
      if (projectIds.length > 0) {
        await client.query(
          `insert into knowledge_projects (knowledge_id, project_id)
           select $1, unnest($2::uuid[])`, [existing.id, projectIds],
        )
      }
    }
  })

  return getKnowledge(actor.userId, slug)
}

/**
 * Slug/title for a set of knowledge ids, keyed by id.
 *
 * `superseded_by` is stored as the row id, not the slug — a slug can be
 * re-derived from a renamed title, an id cannot, so the UI needs this to turn
 * "superseded by <uuid>" into a link a person can follow.
 */
/**
 * The task a fact was learned on, as a ref somebody can follow.
 *
 * `source_task_id` has been stored since knowledge existed and shown nowhere,
 * so "where did we learn this" was a question the data could answer and the
 * product could not. Mirrors `supersededByInfo`: one lookup, ids in, display
 * shapes out.
 */
export const sourceTaskRef = async (
  _userId: string,
  taskId: string | null,
): Promise<{ ref: string; title: string } | null> => {
  if (!taskId) return null

  const { data, error } = await admin()
    .from('tasks')
    .select('number, title, project:projects!project_id!inner(key)')
    .eq('id', taskId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null

  const row = data as unknown as { number: number; title: string; project: { key: string } }
  return { ref: `${row.project.key}-${row.number}`, title: row.title }
}

export const supersededByInfo = async (
  _userId: string,
  ids: string[],
): Promise<Map<string, { slug: string; title: string }>> => {
  const out = new Map<string, { slug: string; title: string }>()
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return out

  const { data, error } = await admin()
    .from('knowledge')
    .select('id, slug, title')
    .in('id', wanted)
  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    out.set(row.id as string, { slug: row.slug as string, title: row.title as string })
  }
  return out
}

export const deleteKnowledge = async (userId: string, slug: string): Promise<boolean> => {
  const existing = await getKnowledge(userId, slug)
  if (!existing) return false

  const { error } = await admin()
    .from('knowledge')
    .delete()
    .eq('id', existing.id)
  if (error) throw new Error(error.message)
  return true
}
