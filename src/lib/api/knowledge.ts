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

const withProjects = async (rows: KnowledgeRow[]): Promise<KnowledgeRow[]> => {
  const keys = await projectKeysFor(rows.map((r) => r.id))
  return rows.map((r) => ({ ...r, projects: keys.get(r.id) ?? [] }))
}

export const listKnowledge = async (
  userId: string,
  filters: { project?: string; label?: string; limit: number; includeSuperseded?: boolean },
): Promise<KnowledgeRow[]> => {
  let query = admin()
    .from('knowledge')
    .select(COLUMNS)
    .eq('owner_user_id', userId)
    .order('updated_at', { ascending: false })

  if (filters.label) query = query.contains('labels', [filters.label])
  if (!filters.includeSuperseded) query = query.is('superseded_by', null)

  if (filters.project) {
    // Project-scoped reads include the global rows on purpose: the question is
    // "what do we know that applies here", and an infra gotcha applies here.
    //
    // The narrowing has to happen IN the query. Filtering after a LIMIT looked
    // identical and was not: once 200 rows were imported, the twelve most
    // recently updated were all from other projects, so the briefing's
    // knowledge section silently went empty.
    const { ids } = await resolveProjects(userId, [filters.project])
    if (ids.length === 0) return []

    const [scoped, globals] = await Promise.all([
      admin().from('knowledge_projects').select('knowledge_id').eq('project_id', ids[0]),
      globalIds(userId),
    ])
    if (scoped.error) throw new Error(scoped.error.message)

    const allowed = [
      ...new Set([...(scoped.data ?? []).map((r) => r.knowledge_id as string), ...globals]),
    ]
    if (allowed.length === 0) return []
    query = query.in('id', allowed)
  }

  const { data, error } = await query.limit(filters.limit)
  if (error) throw new Error(error.message)

  return withProjects((data ?? []) as unknown as KnowledgeRow[])
}

/** Rows with no project links at all — the supra-project set. */
const globalIds = async (userId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('id, knowledge_projects(knowledge_id)')
    .eq('owner_user_id', userId)
  if (error) throw new Error(error.message)

  return (data ?? [])
    .filter((r) => ((r.knowledge_projects as unknown[]) ?? []).length === 0)
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
