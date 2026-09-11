import { admin } from '@/lib/supabase/admin'
import type { Actor } from './auth'
import type { SessionUpsert } from '@/schemas/session'
import { recordFiles } from './files'

/**
 * Sessions: the episodic record, written at the end of one.
 *
 * This is the half of memory an agent cannot be trusted to write on purpose,
 * so nothing here depends on it choosing to. A session-end hook posts what the
 * transcript already contains; the only judgement involved is four prose
 * fields, and a session with none of them is still worth the row.
 *
 * Idempotent on (platform_source, external_id) because that is a correctness
 * requirement, not a nicety: Codex has no session-end event so its writer runs
 * on Stop, which fires once per turn, and OpenClaw's runs from a reconciler
 * that may sweep a session the hook already recorded.
 */

const COLUMNS =
  'id, external_id, platform_source, agent_id, cwd, project_id, started_at, ended_at, ' +
  'request, learned, completed, next_steps, files, task_refs, tool_calls, created_at, updated_at'

export type SessionRow = {
  id: string
  external_id: string
  platform_source: string
  agent_id: string | null
  cwd: string | null
  project_id: string | null
  started_at: string | null
  ended_at: string | null
  request: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  files: string[]
  task_refs: string[]
  tool_calls: number | null
  created_at: string
  updated_at: string
}

const projectIdForKey = async (userId: string, key?: string): Promise<string | null> => {
  if (!key) return null
  const { data, error } = await admin()
    .from('projects')
    .select('id')
    .eq('owner_user_id', userId)
    .eq('key', key.toUpperCase())
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.id as string) ?? null
}

/**
 * Checkpoints every task this agent still holds, using the session summary.
 *
 * This is the discipline mechanism, and the reason it lives on the server
 * rather than in the hook: whatever the agent did or did not bother to record,
 * a claim it walked away from stops being a phantom hold on the board. It
 * never *closes* anything — closing needs a resolution somebody meant.
 */
const checkpointHeldTasks = async (actor: Actor, session: SessionRow): Promise<string[]> => {
  if (!actor.actorId) return []

  const { data, error } = await admin()
    .from('tasks')
    .select('id, number, project:projects!project_id!inner(key, owner_user_id)')
    .eq('claimed_by', actor.actorId)
    .eq('projects.owner_user_id', actor.userId)
  if (error) throw new Error(error.message)

  const held = (data ?? []) as unknown as {
    id: string
    number: number
    project: { key: string }
  }[]
  if (held.length === 0) return []

  const summary = [session.completed, session.next_steps && `Next: ${session.next_steps}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4_000)

  if (!summary) return []

  const stamped = `${summary}\n\n_Recorded automatically when the session ended._`
  const at = session.ended_at ?? new Date().toISOString()

  const { error: updateError } = await admin()
    .from('tasks')
    .update({ checkpoint_summary: stamped, checkpoint_at: at })
    .in(
      'id',
      held.map((t) => t.id),
    )
  if (updateError) throw new Error(updateError.message)

  return held.map((t) => `${t.project.key}-${t.number}`)
}

export const upsertSession = async (actor: Actor, input: SessionUpsert) => {
  const projectId = await projectIdForKey(actor.userId, input.project)

  const row = {
    owner_user_id: actor.userId,
    external_id: input.externalId,
    platform_source: input.platformSource,
    agent_id: input.agentId ?? actor.actorId ?? null,
    cwd: input.cwd ?? null,
    project_id: projectId,
    started_at: input.startedAt ?? null,
    ended_at: input.endedAt ?? new Date().toISOString(),
    request: input.request ?? null,
    learned: input.learned ?? null,
    completed: input.completed ?? null,
    next_steps: input.nextSteps ?? null,
    files: input.files,
    task_refs: input.taskRefs,
    tool_calls: input.toolCalls ?? null,
  }

  const { data, error } = await admin()
    .from('sessions')
    .upsert(row, { onConflict: 'platform_source,external_id' })
    .select(COLUMNS)
    .single<SessionRow>()

  if (error) throw new Error(error.message)

  await recordFiles(actor.userId, {
    paths: input.files,
    sessionId: data.id,
    projectId,
  })

  const checkpointed = input.checkpointHeld ? await checkpointHeldTasks(actor, data) : []

  return { session: data, checkpointed }
}

export const listSessions = async (
  userId: string,
  filters: { project?: string; cwd?: string; limit: number },
): Promise<SessionRow[]> => {
  let query = admin()
    .from('sessions')
    .select(COLUMNS)
    .eq('owner_user_id', userId)
    .order('ended_at', { ascending: false, nullsFirst: false })
    .limit(filters.limit)

  if (filters.cwd) query = query.eq('cwd', filters.cwd)
  if (filters.project) {
    const projectId = await projectIdForKey(userId, filters.project)
    if (!projectId) return []
    query = query.eq('project_id', projectId)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SessionRow[]
}
