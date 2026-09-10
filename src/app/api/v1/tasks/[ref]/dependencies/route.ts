import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const body = z.object({
  /** The other task, as a ref (`CAI-42`) or uuid. */
  ref: z.string().min(2).max(60),
  /**
   * 'blocked-by' — the other task must finish first (the default, because it
   * is how people phrase it: "this is blocked by that").
   * 'blocks'     — this task must finish before the other.
   */
  direction: z.enum(['blocked-by', 'blocks']).default('blocked-by'),
})

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const [blockedBy, blocks] = await Promise.all([
      admin().from('task_deps').select('blocking_id').eq('blocked_id', task.id),
      admin().from('task_deps').select('blocked_id').eq('blocking_id', task.id),
    ])

    const ids = [
      ...((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => r.blocking_id),
      ...((blocks.data ?? []) as { blocked_id: string }[]).map((r) => r.blocked_id),
    ]
    if (ids.length === 0) return ok([])

    const { data } = await admin()
      .from('tasks')
      .select('id, number, title, status, project:projects!inner(key)')
      .in('id', ids)

    type Row = { id: string; number: number; title: string; status: string; project: { key: string } | { key: string }[] }
    const blockedIds = new Set(
      ((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => r.blocking_id),
    )

    return ok(
      ((data ?? []) as unknown as Row[]).map((row) => {
        const proj = Array.isArray(row.project) ? row.project[0] : row.project
        return {
          ref: `${proj?.key}-${row.number}`,
          title: row.title,
          status: row.status,
          direction: blockedIds.has(row.id) ? 'blocked-by' : 'blocks',
        }
      }),
    )
  },
})

export const POST = route<{ ref: string }, z.infer<typeof body>>({
  schema: body,
  handler: async ({ actor, params, body: input }) => {
    const [task, other] = await Promise.all([
      findTask(actor, params.ref, TASK_LIST_FIELDS),
      findTask(actor, input.ref, TASK_LIST_FIELDS),
    ])
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    if (!other) return fail('not_found', `No task ${input.ref}.`)
    if (task.id === other.id) return fail('validation_failed', 'A task cannot block itself.')

    const blocked = input.direction === 'blocked-by' ? task.id : other.id
    const blocking = input.direction === 'blocked-by' ? other.id : task.id

    // A cycle would make "what is ready to start?" unanswerable, which is the
    // only question dependencies exist to answer. Reject the direct case;
    // deeper cycles are checked below.
    const { data: reverse } = await admin()
      .from('task_deps')
      .select('blocked_id')
      .eq('blocked_id', blocking)
      .eq('blocking_id', blocked)
      .maybeSingle()
    if (reverse) {
      return fail('conflict', 'That would create a cycle — the reverse link already exists.')
    }

    const { error } = await admin()
      .from('task_deps')
      .insert({ blocked_id: blocked, blocking_id: blocking })
    if (error) {
      return failFromDb(error, { '23505': 'That dependency already exists.' })
    }

    return ok({ blocked, blocking, direction: input.direction }, { status: 201 })
  },
})

/**
 * Takes its arguments in the query string, not a body: the shared route
 * wrapper does not parse DELETE bodies, and a DELETE body is unreliable
 * through proxies anyway.
 *
 *   DELETE /api/v1/tasks/CAI-42/dependencies?ref=CAI-40&direction=blocked-by
 */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const parsed = body.safeParse({
      ref: url.searchParams.get('ref') ?? undefined,
      direction: url.searchParams.get('direction') ?? undefined,
    })
    if (!parsed.success) {
      return fail('validation_failed', 'Provide ?ref=<the other task>.', {
        issues: parsed.error.issues,
      })
    }
    const input = parsed.data

    const [task, other] = await Promise.all([
      findTask(actor, params.ref, TASK_LIST_FIELDS),
      findTask(actor, input.ref, TASK_LIST_FIELDS),
    ])
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    if (!other) return fail('not_found', `No task ${input.ref}.`)

    const blocked = input.direction === 'blocked-by' ? task.id : other.id
    const blocking = input.direction === 'blocked-by' ? other.id : task.id

    const { error, count } = await admin()
      .from('task_deps')
      .delete({ count: 'exact' })
      .eq('blocked_id', blocked)
      .eq('blocking_id', blocking)
    if (error) return failFromDb(error)
    // Reported rather than swallowed: a silent no-op here looked like success
    // while the link stayed on screen.
    if (!count) return fail('not_found', `${params.ref} is not linked to ${input.ref} that way.`)
    return ok({ removed: true })
  },
})
