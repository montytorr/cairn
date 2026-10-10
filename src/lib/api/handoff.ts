import type { PoolClient } from 'pg'
import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import { isTerminal, RESOLUTION_KINDS, type TaskStatus } from '@/schemas/task'
import type { Actor } from './auth'
import { diffTaskEvents, withHost, type ActivityEvent } from './activity'
import { isLabEnabled } from './lab-settings'
import {
  closedInKind,
  closedInResolution,
  HANDOFF_COLUMNS,
  handoffOf,
  handoffOutcomeHash,
  handoffOutcomeNote,
  isTerminalHandoff,
  subjectRef,
  type Handoff,
} from './lab-shape'
import { addSubjectNote } from './subjects'

/**
 * Hand-off to another tracker or another Cairn instance (docs/lab.md; ported
 * from Croft's 080 and lib/api/handoff.ts).
 *
 * The CLI's adapter creates the task over there, then records the link here.
 * From then on that tracker owns the task's status: claims, releases and
 * status changes are refused with 409 `handed_off` until the hand-off ends
 * (the tracker reports done or cancelled) or is taken back. Nothing here
 * calls a tracker; the tracker is data on the link.
 *
 * Not a Lab feature, but a todo's subject hears about it — only while the Lab
 * is on. While it is off nothing here reads or writes subject data.
 */

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

type LinkedRow = {
  id: string
  status: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  subject_id: string | null
  project_id: string
  handoff_tracker: string | null
  handoff_ref: string | null
  handoff_url: string | null
  handoff_status: string | null
  handoff_synced_at: string | null
}

const LINKED_COLUMNS = `id, status, resolution, resolution_kind, claimed_by, subject_id, project_id, ${HANDOFF_COLUMNS}`

/** Events written in the caller's transaction, so they land with the change or not at all. */
const insertEvents = async (client: PoolClient, actor: Actor, events: ActivityEvent[]) => {
  for (const event of withHost(events, actor.host)) {
    await client.query(
      `insert into task_activity_events (owner_user_id, task_id, project_id, subject_id, actor_type, actor_id, event, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actor.userId,
        event.task_id ?? null,
        event.project_id ?? null,
        event.subject_id ?? null,
        event.actor_type,
        event.actor_id,
        event.event,
        JSON.stringify(event.data),
      ],
    )
  }
}

const subjectRefOf = async (client: PoolClient, subjectId: string | null, labOn: boolean) => {
  if (!labOn || !subjectId) return null
  const { rows: found } = await client.query<{ number: number }>('select number from subjects where id = $1', [subjectId])
  return found[0] ? subjectRef(found[0].number) : null
}

export type LinkInput = {
  tracker: string
  ref: string
  url?: string | null
  status?: string
  resolution?: string
  resolutionKind?: string
}

export type LinkResult = {
  ref: string
  id: string
  subject: string | null
  handoff: Handoff | null
  status: string
  noted: boolean
  closed: boolean
}

/**
 * Links, re-links or syncs, in one transaction with the task row locked, so
 * the columns, the claim release, the events, the close and the subject's log
 * land together or not at all.
 *
 * Same tracker and ref as the current link is a sync: the reported status
 * (and url, if sent) are recorded, nothing else is written unless the status
 * ends it. Anything else is a (re-)link: the claim is released, and the
 * subject's log says where the work went.
 */
export const linkHandoff = async (actor: Actor, task: { id: string; ref: string }, input: LinkInput): Promise<LinkResult> => {
  const labOn = await isLabEnabled()

  return transaction(async (client) => {
    const before = rows<LinkedRow>(
      await client.query(`select ${LINKED_COLUMNS} from tasks where id = $1 for update`, [task.id]),
    )[0]!
    const current = handoffOf(before)
    const same = current?.tracker === input.tracker && current.ref === input.ref
    const subjectId = labOn ? before.subject_id : null

    const updated = rows<LinkedRow>(
      await client.query(
        `update tasks
            set handoff_tracker = $2,
                handoff_ref = $3,
                handoff_url = case when $4::text is not null then $4::text when $6::boolean then handoff_url else null end,
                handoff_status = case when $5::text is not null then $5::text when $6::boolean then handoff_status else null end,
                handoff_synced_at = now(),
                -- Leaving for another tracker releases the claim: the work is held there now.
                claimed_by = case when $6::boolean then claimed_by else null end,
                claimed_session = case when $6::boolean then claimed_session else null end,
                claimed_at = case when $6::boolean then claimed_at else null end,
                heartbeat_at = case when $6::boolean then heartbeat_at else null end,
                status = case when not $6::boolean and status = 'doing' then 'todo' else status end
          where id = $1
          returning ${LINKED_COLUMNS}`,
        [task.id, input.tracker, input.ref, input.url ?? null, input.status ?? null, same],
      ),
    )[0]!

    let noted = false
    if (!same) {
      const base = {
        task_id: task.id,
        project_id: before.project_id,
        subject_id: subjectId,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
      }
      const events: ActivityEvent[] = [
        {
          ...base,
          event: 'handed_off',
          data: {
            tracker: input.tracker,
            ref: input.ref,
            url: updated.handoff_url,
            from: current ? `${current.tracker}:${current.ref}` : null,
          },
        },
      ]
      if (before.claimed_by) events.push({ ...base, event: 'released', data: { reason: 'handed_off', holder: before.claimed_by } })
      if (before.status === 'doing') events.push({ ...base, event: 'status_changed', data: { from: 'doing', to: 'todo', via: 'handoff' } })
      await insertEvents(client, actor, events)

      if (subjectId) {
        const written = await addSubjectNote(
          actor,
          subjectId,
          { kind: 'handoff', note: `${task.ref} handed off to ${input.tracker} as ${input.ref}` },
          undefined,
          client,
        )
        noted = !written.duplicate
      }
    }

    // An ended hand-off: the subject's log learns how it ended, once, and the
    // task closes with the same status, once.
    let closed = false
    if (input.status && isTerminalHandoff(input.status)) {
      if (subjectId) {
        const written = await addSubjectNote(
          actor,
          subjectId,
          {
            kind: input.status === 'done' ? 'finding' : 'note',
            note: handoffOutcomeNote(input.ref, input.status, input.resolution),
          },
          handoffOutcomeHash(input.tracker, input.ref, input.status),
          client,
        )
        noted = noted || !written.duplicate
      }
      if (!isTerminal(updated.status as TaskStatus)) {
        await closeHandedOff(client, actor, updated, {
          status: input.status,
          resolution: closedInResolution(input.tracker, input.ref, input.resolution),
          resolutionKind: closedInKind(input.resolutionKind, RESOLUTION_KINDS),
        })
        closed = true
      }
    }

    return {
      ref: task.ref,
      id: task.id,
      subject: await subjectRefOf(client, before.subject_id, labOn),
      handoff: handoffOf(updated),
      status: closed ? (input.status as string) : updated.status,
      noted,
      closed,
    }
  })
}

/**
 * Closes a task whose hand-off ended: the one path that closes a task while
 * its link is open. Mirrors PATCH's close — claim released, resolution
 * recorded, events written — without its refusals.
 */
const closeHandedOff = async (
  client: PoolClient,
  actor: Actor,
  task: LinkedRow,
  outcome: { status: 'done' | 'cancelled'; resolution: string; resolutionKind: string },
) => {
  const patch: Record<string, unknown> = {
    status: outcome.status,
    resolution: outcome.resolution,
    resolution_kind: outcome.resolutionKind,
    resolved_at: new Date().toISOString(),
    resolved_by: actor.actorId,
    ...(task.claimed_by ? { claimed_by: null, claimed_session: null, claimed_at: null, heartbeat_at: null } : {}),
  }
  await client.query(
    `update tasks set status = $2, resolution = $3, resolution_kind = $4, resolved_at = now(), resolved_by = $5,
            claimed_by = null, claimed_session = null, claimed_at = null, heartbeat_at = null
      where id = $1`,
    [task.id, outcome.status, outcome.resolution, outcome.resolutionKind, actor.actorId],
  )
  await insertEvents(
    client,
    actor,
    diffTaskEvents(actor, task.id, task as unknown as Record<string, unknown>, patch).map((e) => ({
      ...e,
      project_id: task.project_id,
    })),
  )
}

/** Takes a hand-off back. Nothing is done in the other tracker. Null when the task is not handed off. */
export const unlinkHandoff = async (actor: Actor, task: { id: string; ref: string }): Promise<Handoff | null> => {
  const labOn = await isLabEnabled()

  return transaction(async (client) => {
    const before = rows<LinkedRow>(
      await client.query(`select ${LINKED_COLUMNS} from tasks where id = $1 for update`, [task.id]),
    )[0]
    const handoff = handoffOf(before)
    if (!before || !handoff) return null

    await client.query(
      `update tasks
          set handoff_tracker = null, handoff_ref = null, handoff_url = null,
              handoff_status = null, handoff_synced_at = null
        where id = $1`,
      [task.id],
    )
    const subjectId = labOn ? before.subject_id : null
    await insertEvents(client, actor, [
      {
        task_id: task.id,
        project_id: before.project_id,
        subject_id: subjectId,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'handoff_taken_back',
        data: { tracker: handoff.tracker, ref: handoff.ref },
      },
    ])
    if (subjectId) {
      await addSubjectNote(
        actor,
        subjectId,
        { kind: 'handoff', note: `${task.ref} taken back from ${handoff.tracker} (${handoff.ref})` },
        undefined,
        client,
      )
    }
    return handoff
  })
}

/** What `cairn sync` walks: tasks with a hand-off, open ones by default. Subjects only while the Lab is on. */
export const listHandoffs = async (filters: {
  state: 'open' | 'ended' | 'all'
  tracker?: string
  projectId?: string
  limit: number
}) => {
  const labOn = await isLabEnabled()
  const result = await pool().query(
    `select t.id, p.key, t.number, t.title, t.status, s.number as subject_number,
            ${HANDOFF_COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')}
       from tasks t
       join projects p on p.id = t.project_id
       left join subjects s on s.id = t.subject_id and $5::boolean
      where t.handoff_ref is not null
        and ($1::text = 'all'
             or ($1::text = 'open' and coalesce(t.handoff_status, '') not in ('done', 'cancelled'))
             or ($1::text = 'ended' and t.handoff_status in ('done', 'cancelled')))
        and ($2::text is null or t.handoff_tracker = $2::text)
        and ($3::uuid is null or t.project_id = $3::uuid)
      order by t.handoff_synced_at nulls first, t.updated_at
      limit $4`,
    [filters.state, filters.tracker ?? null, filters.projectId ?? null, filters.limit, labOn],
  )
  return rows<Record<string, unknown> & { key: string; number: number; subject_number: number | null }>(result).map(
    (row) => ({
      ref: `${row.key}-${row.number}`,
      title: row.title,
      status: row.status,
      subject: row.subject_number ? subjectRef(row.subject_number) : null,
      handoff: handoffOf(row),
    }),
  )
}
