import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { listKnowledge } from './knowledge'
import { stalenessFor } from './staleness'
import { contextForFile, type FileContext } from './files'
import { projectForCwd, projectForRepo } from './project-resolution'
import { formerKeysByProject, formerRefsOf, liveProjectKey, resolveProject, type FormerKey, type KeyRename } from './project-keys'

/**
 * The briefing a session opens with.
 *
 * The store this replaces injected 12.2 KB into every session: fifty
 * observation one-liners, ten session summaries and five full narratives, on
 * the theory that more context is better context. It was consulted 103 times
 * in seventeen days.
 *
 * This is the opposite bet. Only things that require the reader to act or that
 * change what they would do next: what you are still holding, what is in
 * flight around you, where the last session in this directory stopped, and
 * what is known here. Titles and refs, never bodies — same contract as
 * `cairn check`.
 */

/** Matches the claim lease in the claim route. A claim older than this is takeable. */
const LEASE_MINUTES = 15

/** Past this with no note, a held task is a hold nobody is acting on. */
const QUIET_HOURS = 24

export type ContextPayload = {
  project: string | null
  /**
   * Set when the project asked for is a key it used to have — typically a
   * checkout mapped before the rename. The briefing answers for the live
   * project and says so, instead of briefing on nothing (CAIRN-264).
   */
  projectRenamed?: KeyRename
  held: {
    ref: string
    title: string
    status: string
    claimedAt: string | null
    lastNoteAt: string | null
    quiet: boolean
    /**
     * The refs this task had before a RECENT rename of its project, so an
     * agent that wrote AC-113 in its notes yesterday recognises HOL-113 today.
     * Only keys retired after the task existed, and only within
     * RECENT_RENAME_DAYS — past that the old ref is history, not news.
     */
    was?: string[]
  }[]
  inFlight: {
    ref: string
    title: string
    status: string
    claimedBy: string | null
    /** How long since anything happened on it, for the reader to judge. */
    quietFor: string
    /**
     * In progress, nobody on it, and quiet long enough that it is not being
     * worked on. Work that was started and dropped is the easiest thing in
     * the tracker to lose: it is not in anyone's held list and not a stale
     * claim either, so nothing surfaces it again.
     */
    stalled: boolean
  }[]
  lastSession: {
    endedAt: string | null
    request: string | null
    nextSteps: string | null
    agent: string | null
  } | null
  knowledge: { slug: string; title: string; scope: string; stale: boolean }[]
  staleClaims: { ref: string; title: string; claimedBy: string; heldFor: string }[]
  file?: FileContext
}

const TASK_SELECT =
  'id, number, title, status, claimed_by, claimed_at, heartbeat_at, updated_at, ' +
  'project:projects!project_id!inner(key)'

/** Held tasks also carry what a recent rename is measured against. */
const HELD_SELECT = `${TASK_SELECT}, project_id, created_at`

export class ContextScopeError extends Error {
  constructor() { super('project scope requires a resolved project') }
}

export class ContextProjectNotFoundError extends Error {
  constructor() { super('Project not found') }
}

/** How long a key change stays worth mentioning beside a held ref. */
export const RECENT_RENAME_DAYS = 30

/**
 * The former refs worth showing beside a held task: keys retired after the
 * task was created (earlier ones never named it) and within the window.
 */
export const recentFormerRefs = (
  task: { number: number; created_at?: string | null },
  formerKeys: Pick<FormerKey, 'key' | 'retired_at'>[],
  now = Date.now(),
): string[] =>
  formerRefsOf(
    task,
    formerKeys.filter(
      (former) => now - Date.parse(former.retired_at) <= RECENT_RENAME_DAYS * 86_400_000,
    ),
  )

type TaskRow = {
  id: string
  number: number
  title: string
  status: string
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  updated_at: string | null
  project: { key: string }
}

const refOf = (t: TaskRow) => `${t.project.key}-${t.number}`

const humanDuration = (fromIso: string | null): string => {
  if (!fromIso) return 'unknown'
  const minutes = Math.round((Date.now() - new Date(fromIso).getTime()) / 60_000)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export const buildContext = async (
  actor: Actor,
  input: { cwd?: string; project?: string; file?: string; repo?: string; scope?: 'all' | 'project' },
): Promise<ContextPayload> => {
  // A key given explicitly may be one the project no longer has — every
  // checkout mapped before a rename sends it — so it is resolved to the live
  // key rather than matched as a string that no row carries any more.
  const resolved = input.scope === 'project' && input.project
    ? await resolveProject(input.project)
    : null
  if (input.scope === 'project' && input.project && !resolved) throw new ContextProjectNotFoundError()
  const asked = input.project
    ? resolved ? { key: resolved.project.key, renamed: resolved.renamed } : await liveProjectKey(input.project)
    : null
  const project =
    asked?.key ??
    (input.repo ? await projectForRepo(actor.userId, input.repo) : null) ??
    (input.cwd ? await projectForCwd(actor.userId, input.cwd) : null)
  const scopedProject = input.scope === 'project' ? project : null
  if (input.scope === 'project' && !scopedProject) throw new ContextScopeError()

  // --- what this agent is still holding ---------------------------------
  const held: ContextPayload['held'] = []
  if (actor.actorId) {
    let query = admin()
      .from('tasks')
      .select(HELD_SELECT)
      .eq('claimed_by', actor.actorId)
    if (scopedProject) query = query.eq('projects.key', scopedProject)
    const { data, error } = await query
      .order('claimed_at', { ascending: true })
      .limit(10)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as (TaskRow & { project_id: string; created_at: string | null })[]
    const [lastNotes, formerKeys] = await Promise.all([
      lastNoteTimes(rows.map((r) => r.id)),
      formerKeysByProject([...new Set(rows.map((r) => r.project_id))]),
    ])

    for (const row of rows) {
      const lastNoteAt = lastNotes.get(row.id) ?? null
      const since = lastNoteAt ?? row.claimed_at
      const quiet = Boolean(
        since && Date.now() - new Date(since).getTime() > QUIET_HOURS * 3_600_000,
      )
      const was = recentFormerRefs(row, formerKeys.get(row.project_id) ?? [])
      held.push({
        ref: refOf(row),
        title: row.title,
        status: row.status,
        claimedAt: row.claimed_at,
        lastNoteAt,
        quiet,
        ...(was.length > 0 ? { was } : {}),
      })
    }
  }

  // --- what else is in flight here --------------------------------------
  let inFlight: ContextPayload['inFlight'] = []
  if (project) {
    const { data, error } = await admin()
      .from('tasks')
      .select(TASK_SELECT)
      .eq('projects.key', project)
      .in('status', ['doing', 'in-review'])
      .order('updated_at', { ascending: false })
      .limit(8)
    if (error) throw new Error(error.message)
    inFlight = ((data ?? []) as unknown as TaskRow[]).map((row) => {
      const quietSince = row.heartbeat_at ?? row.updated_at
      const quietMs = quietSince ? Date.now() - new Date(quietSince).getTime() : 0
      return {
        ref: refOf(row),
        title: row.title,
        status: row.status,
        claimedBy: row.claimed_by,
        quietFor: humanDuration(quietSince),
        stalled: !row.claimed_by && quietMs > QUIET_HOURS * 3_600_000,
      }
    })
  }

  // --- where the last session here stopped ------------------------------
  let lastSession: ContextPayload['lastSession'] = null
  if (input.cwd || project) {
    let query = admin()
      .from('sessions')
      .select('ended_at, request, next_steps, agent_id, cwd, project_id' +
        (scopedProject ? ', project:projects!project_id!inner(key)' : ''))
      .order('ended_at', { ascending: false, nullsFirst: false })
      .limit(1)

    query = input.cwd ? query.eq('cwd', input.cwd) : query
    if (scopedProject) query = query.eq('projects.key', scopedProject)

    const { data, error } = await query.maybeSingle()
    if (error) throw new Error(error.message)
    if (data) {
      lastSession = {
        endedAt: data.ended_at as string | null,
        request: data.request as string | null,
        nextSteps: data.next_steps as string | null,
        agent: data.agent_id as string | null,
      }
    }
  }

  // --- what is known here, plus what is known everywhere ----------------
  const rows = await listKnowledge(actor.userId, { project: project ?? undefined, limit: 12 })
  // Marked where it is read. A fact whose files several sessions have reworked
  // since it was confirmed still reads exactly like one confirmed this morning,
  // which is how half a dozen Supabase entries outlived the stack they described.
  const aged = await stalenessFor(
    actor.userId,
    rows.map((r) => ({
      id: r.id,
      body: r.body ?? '',
      verified_at: r.verified_at,
      created_at: r.created_at,
      source_task_id: r.source_task_id,
      source_session_id: r.source_session_id,
      source_session_ref: r.source_session_ref ?? null,
    })),
  )
  const knowledge = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    // Derived from `r.scope`, which `listKnowledge` already worked out
    // relative to the project asked for. Reading `r.projects` alone said
    // `global` for every entity-scoped fact — telling the next agent that a
    // fact true of one business is true everywhere, which is the failure
    // entities were introduced to end. Keeping the keys rather than printing
    // the bare tier, because the entity's own name is what a reader can act
    // on and "entity" is not.
    scope:
      r.scope === 'entity'
        ? (r.entities ?? []).join(',') || 'entity'
        : (r.projects ?? []).length === 0
          ? 'global'
          : (r.projects ?? []).join(','),
    stale: Boolean(aged.get(r.id)?.stale),
    unverified_days: aged.get(r.id)?.unverifiedDays ?? null,
  }))

  // --- claims nobody is acting on ---------------------------------------
  const cutoff = new Date(Date.now() - LEASE_MINUTES * 60_000).toISOString()
  let staleQuery = admin()
    .from('tasks')
    .select(TASK_SELECT)
    .not('claimed_by', 'is', null)
    .lt('heartbeat_at', cutoff)
  if (scopedProject) staleQuery = staleQuery.eq('projects.key', scopedProject)
  const { data: staleData, error: staleError } = await staleQuery
    .order('heartbeat_at', { ascending: true })
    .limit(5)
  if (staleError) throw new Error(staleError.message)

  const staleClaims = ((staleData ?? []) as unknown as TaskRow[]).map((row) => ({
    ref: refOf(row),
    title: row.title,
    claimedBy: row.claimed_by ?? 'unknown',
    heldFor: humanDuration(row.claimed_at),
  }))

  const file = input.file ? await contextForFile(actor.userId, input.file) : undefined

  return {
    project,
    ...(asked?.renamed ? { projectRenamed: asked.renamed } : {}),
    held,
    inFlight,
    lastSession,
    knowledge,
    staleClaims,
    file,
  }
}

const lastNoteTimes = async (taskIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out

  const { data, error } = await admin()
    .from('task_notes')
    .select('task_id, created_at')
    .in('task_id', taskIds)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    const id = row.task_id as string
    if (!out.has(id)) out.set(id, row.created_at as string)
  }
  return out
}
