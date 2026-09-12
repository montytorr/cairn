import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { listKnowledge } from './knowledge'
import { contextForFile, type FileContext } from './files'

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
  held: {
    ref: string
    title: string
    status: string
    claimedAt: string | null
    lastNoteAt: string | null
    quiet: boolean
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
  knowledge: { slug: string; title: string; scope: string }[]
  staleClaims: { ref: string; title: string; claimedBy: string; heldFor: string }[]
  file?: FileContext
}

const TASK_SELECT =
  'id, number, title, status, claimed_by, claimed_at, heartbeat_at, updated_at, ' +
  'project:projects!project_id!inner(key, owner_user_id)'

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

/**
 * Which project a working directory belongs to.
 *
 * The caller knows its filesystem and should say; this is the fallback for
 * when it does not. Sessions already recorded against this cwd are the best
 * available evidence, and they are self-correcting — file work under a new
 * directory once and every later session there resolves.
 */
const projectForCwd = async (userId: string, cwd: string): Promise<string | null> => {
  const { data, error } = await admin()
    .from('sessions')
    .select('project:projects(key)')
    .eq('owner_user_id', userId)
    .eq('cwd', cwd)
    .not('project_id', 'is', null)
    .order('ended_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  const embedded = data?.project as unknown as { key: string } | { key: string }[] | null
  const key = Array.isArray(embedded) ? embedded[0]?.key : embedded?.key
  return key ?? null
}

export const buildContext = async (
  actor: Actor,
  input: { cwd?: string; project?: string; file?: string },
): Promise<ContextPayload> => {
  const project =
    input.project?.toUpperCase() ?? (input.cwd ? await projectForCwd(actor.userId, input.cwd) : null)

  // --- what this agent is still holding ---------------------------------
  const held: ContextPayload['held'] = []
  if (actor.actorId) {
    const { data, error } = await admin()
      .from('tasks')
      .select(TASK_SELECT)
      .eq('projects.owner_user_id', actor.userId)
      .eq('claimed_by', actor.actorId)
      .order('claimed_at', { ascending: true })
      .limit(10)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as TaskRow[]
    const lastNotes = await lastNoteTimes(rows.map((r) => r.id))

    for (const row of rows) {
      const lastNoteAt = lastNotes.get(row.id) ?? null
      const since = lastNoteAt ?? row.claimed_at
      const quiet = Boolean(
        since && Date.now() - new Date(since).getTime() > QUIET_HOURS * 3_600_000,
      )
      held.push({
        ref: refOf(row),
        title: row.title,
        status: row.status,
        claimedAt: row.claimed_at,
        lastNoteAt,
        quiet,
      })
    }
  }

  // --- what else is in flight here --------------------------------------
  let inFlight: ContextPayload['inFlight'] = []
  if (project) {
    const { data, error } = await admin()
      .from('tasks')
      .select(TASK_SELECT)
      .eq('projects.owner_user_id', actor.userId)
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
      .select('ended_at, request, next_steps, agent_id, cwd, project_id')
      .eq('owner_user_id', actor.userId)
      .order('ended_at', { ascending: false, nullsFirst: false })
      .limit(1)

    query = input.cwd ? query.eq('cwd', input.cwd) : query

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
  const knowledge = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    scope: (r.projects ?? []).length === 0 ? 'global' : (r.projects ?? []).join(','),
  }))

  // --- claims nobody is acting on ---------------------------------------
  const cutoff = new Date(Date.now() - LEASE_MINUTES * 60_000).toISOString()
  const { data: staleData, error: staleError } = await admin()
    .from('tasks')
    .select(TASK_SELECT)
    .eq('projects.owner_user_id', actor.userId)
    .not('claimed_by', 'is', null)
    .lt('heartbeat_at', cutoff)
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

  return { project, held, inFlight, lastSession, knowledge, staleClaims, file }
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
