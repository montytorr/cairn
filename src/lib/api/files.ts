import { admin } from '@/lib/supabase/admin'

/**
 * The file index: which sessions, tasks and knowledge concern a given path.
 *
 * This exists to answer a question nobody asks. The agent is about to read
 * `src/lib/api/search.ts`; something should say "CAIRN-31 measured ranking
 * here, and knowledge/postgres-ts-rank explains why it is ordered in SQL" —
 * without a search string, without a tool call, without anyone remembering.
 *
 * Nothing here costs a model call. That is the whole reason it is affordable:
 * paths come straight out of a transcript, so this can run on every session
 * where summarising every tool call could not.
 */

/** Rows older than this are pruned per path, so a hot file does not grow forever. */
const MAX_ROWS_PER_PATH = 40

export type FileTouchInput = {
  paths: string[]
  sessionId?: string | null
  taskId?: string | null
  knowledgeId?: string | null
  projectId?: string | null
  kind?: 'touched' | 'modified' | 'discussed'
}

/**
 * Paths are stored as given, but normalised first: a repo-relative path and an
 * absolute one pointing at the same file would split its history in two, which
 * is exactly the failure this index exists to prevent.
 */
export const normalisePath = (path: string): string =>
  path
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')

export const recordFiles = async (userId: string, input: FileTouchInput): Promise<number> => {
  const paths = [...new Set(input.paths.map(normalisePath).filter(Boolean))].slice(0, 400)
  if (paths.length === 0) return 0
  if (!input.sessionId && !input.taskId && !input.knowledgeId) return 0

  const { error } = await admin()
    .from('file_touches')
    .insert(
      paths.map((path) => ({
        owner_user_id: userId,
        path,
        project_id: input.projectId ?? null,
        session_id: input.sessionId ?? null,
        task_id: input.taskId ?? null,
        knowledge_id: input.knowledgeId ?? null,
        kind: input.kind ?? 'touched',
      })),
    )

  if (error) throw new Error(error.message)
  return paths.length
}

export type FileContext = {
  path: string
  tasks: { ref: string; title: string; status: string; resolved: boolean }[]
  knowledge: { slug: string; title: string }[]
  sessions: { endedAt: string | null; request: string | null; nextSteps: string | null }[]
}

/**
 * What is known about a path, as an index.
 *
 * Falls back to the basename when the exact path has nothing: the caller's
 * working directory is rarely the one the path was recorded from, and a miss
 * on a rooting difference is indistinguishable from "nothing is known", which
 * is the more expensive wrong answer.
 */
export const contextForFile = async (userId: string, rawPath: string): Promise<FileContext> => {
  const path = normalisePath(rawPath)
  const basename = path.split('/').pop() ?? path

  const select =
    'path, created_at, ' +
    'task:tasks(number, title, status, has_resolution, project:projects!project_id(key)), ' +
    'knowledge:knowledge(slug, title), ' +
    'session:sessions(ended_at, request, next_steps)'

  const run = async (column: 'path' | 'basename') => {
    const query = admin()
      .from('file_touches')
      .select(select)
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_PATH)

    const { data, error } =
      column === 'path' ? await query.eq('path', path) : await query.like('path', `%/${basename}`)

    if (error) throw new Error(error.message)
    return data ?? []
  }

  let rows = await run('path')
  if (rows.length === 0 && basename !== path) rows = await run('basename')

  const tasks = new Map<string, FileContext['tasks'][number]>()
  const knowledge = new Map<string, FileContext['knowledge'][number]>()
  const sessions: FileContext['sessions'] = []

  for (const row of rows as unknown as Record<string, unknown>[]) {
    const task = row.task as {
      number: number
      title: string
      status: string
      has_resolution: boolean
      project: { key: string } | null
    } | null
    if (task?.project) {
      const ref = `${task.project.key}-${task.number}`
      if (!tasks.has(ref)) {
        tasks.set(ref, {
          ref,
          title: task.title,
          status: task.status,
          resolved: task.has_resolution,
        })
      }
    }

    const known = row.knowledge as { slug: string; title: string } | null
    if (known && !knowledge.has(known.slug)) knowledge.set(known.slug, known)

    const session = row.session as {
      ended_at: string | null
      request: string | null
      next_steps: string | null
    } | null
    if (session && sessions.length < 3) {
      sessions.push({
        endedAt: session.ended_at,
        request: session.request,
        nextSteps: session.next_steps,
      })
    }
  }

  return {
    path,
    tasks: [...tasks.values()].slice(0, 6),
    knowledge: [...knowledge.values()].slice(0, 6),
    sessions,
  }
}
