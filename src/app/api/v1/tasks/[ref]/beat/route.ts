import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/** Keeps a claim alive. Only the holder may beat it. */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const holder = task.claimed_by as string | null
    if (!holder) return fail('conflict', 'Task is not claimed — claim it first.')
    if (holder !== actor.actorId) {
      return fail('already_claimed', `Held by ${holder}, not you.`, { claimedBy: holder })
    }

    const { data, error } = await admin()
      .from('tasks')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('claimed_by', holder)
      .select('id, number, claimed_by, heartbeat_at')
      .single()

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})
