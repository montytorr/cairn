import { createHash } from 'node:crypto'
import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/supabase/admin'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { createNoteSchema, NOTE_KINDS } from '@/schemas/task'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const kind = url.searchParams.get('kind')
    if (kind && !(NOTE_KINDS as readonly string[]).includes(kind)) {
      return fail('validation_failed', `Unknown kind. Valid: ${NOTE_KINDS.join(' | ')}.`)
    }

    let query = admin()
      .from('task_notes')
      .select('id, kind, note, facts, actor_type, actor_id, created_at')
      .eq('task_id', task.id)
    if (kind) query = query.eq('kind', kind)

    const { data, error } = await query.order('created_at', { ascending: false }).limit(200)
    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})

/**
 * The debugging trail. Writes are idempotent on (task, content_hash), so an
 * agent that retries after a timeout does not duplicate its own note.
 */
export const POST = route<{ ref: string }, z.infer<typeof createNoteSchema>>({
  schema: createNoteSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const contentHash = createHash('sha256')
      .update(`${body.kind}\n${body.note}`, 'utf8')
      .digest('hex')
      .slice(0, 32)

    const { data, error } = await admin()
      .from('task_notes')
      .upsert(
        {
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          note: body.note,
          kind: body.kind,
          facts: body.facts ?? null,
          content_hash: contentHash,
        },
        { onConflict: 'task_id,content_hash', ignoreDuplicates: true },
      )
      .select('id, kind, note, facts, actor_type, actor_id, created_at')
      .maybeSingle()

    if (error) return fail('internal_error', error.message)
    // A duplicate write returns no row; report it as a success, not an error.
    return ok(data ?? { duplicate: true }, { status: data ? 201 : 200 })
  },
})
