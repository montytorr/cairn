import { admin } from '@/lib/supabase/admin'
import type { Actor } from './auth'
import { slugify, type KnowledgeCreate, type KnowledgeUpdate } from '@/schemas/knowledge'
import { findTask } from './tasks'

/**
 * Knowledge: the durable half of memory.
 *
 * A task answers "what did we do about X". This answers "what do we know about
 * X" — the infra note, the convention, the gotcha that outlives every task it
 * was learned in. It belongs to no task, and usually to no single project,
 * which is why nothing in Cairn could hold it until now.
 *
 * Every query here is scoped to the owner explicitly. The service-role client
 * bypasses RLS, so that scoping is the boundary, not a belt-and-braces extra.
 */

const COLUMNS =
  'id, slug, title, body, labels, verified_at, superseded_by, actor_type, actor_id, ' +
  'source_task_id, source_session_id, created_at, updated_at'

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
  created_at: string
  updated_at: string
  projects?: string[]
  entities?: string[]
  /** How specifically this applies here. Narrower wins when both are relevant. */
  scope?: 'project' | 'entity' | 'global'
}

/** Entity keys -> ids, owner-scoped. Unknown keys are reported, never invented. */
const resolveEntities = async (userId: string, keys: string[]) => {
  if (keys.length === 0) return { ids: [] as string[], missing: [] as string[] }

  const wanted = [...new Set(keys.map((k) => k.toLowerCase()))]
  const { data, error } = await admin()
    .from('entities')
    .select('id, key')
    .eq('owner_user_id', userId)
    .in('key', wanted)
  if (error) throw new Error(error.message)

  const found = new Map((data ?? []).map((e) => [e.key as string, e.id as string]))
  return {
    ids: wanted.map((k) => found.get(k)).filter((id): id is string => Boolean(id)),
    missing: wanted.filter((k) => !found.has(k)),
  }
}

const relinkEntities = async (knowledgeId: string, entityIds: string[]) => {
  const { error: clearError } = await admin()
    .from('knowledge_entities')
    .delete()
    .eq('knowledge_id', knowledgeId)
  if (clearError) throw new Error(clearError.message)

  if (entityIds.length === 0) return
  const { error } = await admin()
    .from('knowledge_entities')
    .insert(entityIds.map((entity_id) => ({ knowledge_id: knowledgeId, entity_id })))
  if (error) throw new Error(error.message)
}

/** Project keys -> ids, owner-scoped. Unknown keys are reported, never ignored. */
const resolveProjects = async (userId: string, keys: string[]) => {
  if (keys.length === 0) return { ids: [] as string[], missing: [] as string[] }

  const wanted = [...new Set(keys.map((k) => k.toUpperCase()))]
  const { data, error } = await admin()
    .from('projects')
    .select('id, key')
    .eq('owner_user_id', userId)
    .in('key', wanted)

  if (error) throw new Error(error.message)

  const found = new Map((data ?? []).map((p) => [p.key as string, p.id as string]))
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
export const entitiesForProject = async (userId: string, key: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('project_entities')
    .select('entity:entities!inner(key, owner_user_id), project:projects!inner(key, owner_user_id)')
    .eq('projects.owner_user_id', userId)
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

export const listKnowledge = async (
  userId: string,
  filters: { project?: string; label?: string; limit: number; includeSuperseded?: boolean },
): Promise<KnowledgeRow[]> => {
  const base = () => {
    let q = admin()
      .from('knowledge')
      .select(COLUMNS)
      .eq('owner_user_id', userId)
      .order('updated_at', { ascending: false })

    if (filters.label) q = q.contains('labels', [filters.label])
    if (!filters.includeSuperseded) q = q.is('superseded_by', null)
    return q
  }

  if (!filters.project) {
    const { data, error } = await base().limit(filters.limit)
    if (error) throw new Error(error.message)
    return withProjects((data ?? []) as unknown as KnowledgeRow[])
  }

  // What applies here is three things: what was filed against this project,
  // what was filed against a grouping it belongs to, and what is true
  // everywhere. An infra gotcha applies here; so does a Dispofi convention,
  // if this is a Dispofi project.
  const { ids } = await resolveProjects(userId, [filters.project])
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
    .select('knowledge_id, entity:entities!inner(key, owner_user_id)')
    .eq('entities.owner_user_id', userId)
    .in('entities.key', keys)
  if (error) throw new Error(error.message)

  return (data ?? []).map((r) => r.knowledge_id as string)
}

/**
 * Rows scoped to nothing at all — true everywhere.
 *
 * Both link tables have to be checked. Checking only projects made every
 * entity-scoped fact global as well, so scoping the Customer.io notes to
 * `dispofi` left them showing up on the trading projects exactly as before —
 * the change looked applied and did nothing.
 */
const globalIds = async (userId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('id, knowledge_projects(knowledge_id), knowledge_entities(knowledge_id)')
    .eq('owner_user_id', userId)
  if (error) throw new Error(error.message)

  return (data ?? [])
    .filter(
      (r) =>
        ((r.knowledge_projects as unknown[]) ?? []).length === 0 &&
        ((r.knowledge_entities as unknown[]) ?? []).length === 0,
    )
    .map((r) => r.id as string)
}

export const getKnowledge = async (userId: string, slug: string): Promise<KnowledgeRow | null> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select(COLUMNS)
    .eq('owner_user_id', userId)
    .eq('slug', slug)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  const [row] = await withProjects([data as unknown as KnowledgeRow])
  return row ?? null
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

  const { data, error } = await admin()
    .from('knowledge')
    .insert({
      owner_user_id: actor.userId,
      slug,
      title: input.title,
      body: input.body,
      labels: input.labels,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      source_task_id: sourceTaskId,
      source_session_id: input.sourceSessionId ?? null,
      verified_at: input.verified ? new Date().toISOString() : null,
    })
    .select(COLUMNS)
    .single<KnowledgeRow>()

  if (error) {
    if (error.code === '23505') throw new Error(`Knowledge "${slug}" already exists.`)
    throw new Error(error.message)
  }

  if (ids.length > 0) {
    const { error: linkError } = await admin()
      .from('knowledge_projects')
      .insert(ids.map((project_id) => ({ knowledge_id: data.id, project_id })))
    if (linkError) throw new Error(linkError.message)
  }

  if (entities.ids.length > 0) await relinkEntities(data.id, entities.ids)

  const [row] = await withProjects([data as unknown as KnowledgeRow])
  return row
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

  if (Object.keys(fields).length > 0) {
    const { error } = await admin()
      .from('knowledge')
      .update(fields)
      .eq('id', existing.id)
      .eq('owner_user_id', actor.userId)
    if (error) throw new Error(error.message)
  }

  if (patch.entities !== undefined) {
    const entities = await resolveEntities(actor.userId, patch.entities)
    if (entities.missing.length > 0) {
      throw new Error(`No such entity: ${entities.missing.join(', ')}`)
    }
    await relinkEntities(existing.id, entities.ids)
  }

  // Project links are replaced wholesale when given: an explicit list is a
  // statement about where this applies, not an addition to it.
  if (patch.projects !== undefined) {
    const { ids, missing } = await resolveProjects(actor.userId, patch.projects)
    if (missing.length > 0) throw new Error(`No such project: ${missing.join(', ')}`)

    const { error: clearError } = await admin()
      .from('knowledge_projects')
      .delete()
      .eq('knowledge_id', existing.id)
    if (clearError) throw new Error(clearError.message)

    if (ids.length > 0) {
      const { error: linkError } = await admin()
        .from('knowledge_projects')
        .insert(ids.map((project_id) => ({ knowledge_id: existing.id, project_id })))
      if (linkError) throw new Error(linkError.message)
    }
  }

  return getKnowledge(actor.userId, slug)
}

/**
 * Slug/title for a set of knowledge ids, keyed by id.
 *
 * `superseded_by` is stored as the row id, not the slug — a slug can be
 * re-derived from a renamed title, an id cannot, so the UI needs this to turn
 * "superseded by <uuid>" into a link a person can follow. Owner-scoped like
 * every other read here, even though the ids passed in were already read off
 * the caller's own rows.
 */
export const supersededByInfo = async (
  userId: string,
  ids: string[],
): Promise<Map<string, { slug: string; title: string }>> => {
  const out = new Map<string, { slug: string; title: string }>()
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return out

  const { data, error } = await admin()
    .from('knowledge')
    .select('id, slug, title')
    .eq('owner_user_id', userId)
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
    .eq('owner_user_id', userId)
  if (error) throw new Error(error.message)
  return true
}
