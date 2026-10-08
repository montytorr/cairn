import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, refuseArchived } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/**
 * Withdraw a note you wrote.
 *
 * There was no way to remove one, which sounds like healthy friction for a
 * store whose value is that things do not vanish — until a note is written by
 * mistake. A probe note left on a live task could not be taken back, and a
 * scratch task that had acquired any note became permanently undeletable,
 * because `task delete` refuses anything carrying a work log. The two rules
 * met and left junk that nothing could remove.
 *
 * An agent may withdraw only its own, and only ever one at a time: a work log
 * is the record of what was tried, and letting one agent erase another's would
 * make it untrustworthy in a way that losing a single mistaken line is not.
 *
 * A person signed in to the web app may withdraw any note on a task they can
 * open. Agents write most decisions, and the person whose account they run
 * under had no way to take back a wrong one: the author is "claude-code · you",
 * and the browser is only ever "you". A human choosing to delete a line is the
 * judgement the rule exists to protect, not the thing it guards against.
 */
export const DELETE = route<{ ref: string; id: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, 'id, number')
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const { data: note } = await admin()
      .from('task_notes')
      .select('id, actor_id, kind')
      .eq('id', params.id)
      .eq('task_id', task.id)
      .maybeSingle()

    if (!note) return fail('not_found', 'No such note on this task.')

    const row = note as { id: string; actor_id: string; kind: string }
    if (actor.actorType !== 'human' && row.actor_id !== actor.actorId) {
      return fail(
        'forbidden',
        `That note was written by ${row.actor_id}. A work log is the record of what was ` +
          `tried, so only its author, or a person in the web app, can withdraw a line of it.`,
      )
    }

    const { error } = await admin().from('task_notes').delete().eq('id', row.id)
    if (error) return fail('internal_error', error.message)
    return ok({ deleted: true, id: row.id })
  },
})
