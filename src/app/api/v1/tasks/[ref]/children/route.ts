import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { isTerminal, type TaskStatus } from '@/schemas/task'

export const dynamic = 'force-dynamic'

/**
 * Direct children and the rollup.
 *
 * Closed rather than done: a cancelled sub-task is decided, and reporting a
 * parent as permanently incomplete because one piece was dropped makes the
 * number worthless.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('tasks')
      .select('id, number, title, type, status, priority, project:projects!project_id!inner(key)')
      .eq('parent_id', task.id)
      .order('created_at')

    if (error) return fail('internal_error', error.message)

    type Row = {
      id: string
      number: number
      title: string
      type: string
      status: string
      priority: string
      project: { key: string } | { key: string }[]
    }

    const children = ((data ?? []) as unknown as Row[]).map((row) => {
      const project = Array.isArray(row.project) ? row.project[0] : row.project
      return {
        ref: `${project?.key}-${row.number}`,
        title: row.title,
        type: row.type,
        status: row.status,
        priority: row.priority,
      }
    })

    const closed = children.filter((c) => isTerminal(c.status as TaskStatus)).length
    return ok({ count: children.length, closed, children })
  },
})
