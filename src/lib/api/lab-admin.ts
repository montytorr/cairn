import type { Pool, PoolClient } from 'pg'
import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import type { Actor } from './auth'
import { fail } from './response'
import type { StageCategory } from './lab-shape'

/**
 * The board's furniture: stages (the lanes) and tags (the curated filter).
 * Everyone reads them; only an administrator changes them, because a stage
 * renamed or deleted moves every subject in it for the whole instance.
 * Ported from Croft's lab-admin, on 071's `lab_stages` and `lab_tags`.
 */

type Db = Pool | PoolClient

export type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response }

export type Stage = { id: string; name: string; category: StageCategory; color: string; position: number }
export type Tag = { id: string; name: string; color: string; position: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: string) => UUID.test(value)

/**
 * Administrators, by role: a human session or an agent key an admin owns.
 * Stages and tags are shared configuration, not credentials, so an admin's
 * agent keeping them tidy is fine. The switch itself needs a human
 * (`canAdministerUsers`), as branding does.
 */
export const isLabAdmin = (actor: Pick<Actor, 'role'>) => actor.role === 'admin'

export const refuseNonAdmin = (actor: Pick<Actor, 'role'>, what: string): Response | null =>
  isLabAdmin(actor) ? null : fail('forbidden', `Only an administrator can change ${what}.`)

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const STAGE_COLUMNS = 'id, name, category, color, position'

export const listStages = async (db: Db = pool()): Promise<Stage[]> =>
  rows<Stage>(await db.query(`select ${STAGE_COLUMNS} from lab_stages order by position, name`))

/** A stage by id, or by name in any case. */
export const findStage = async (ref: string, db: Db = pool()): Promise<Stage | null> => {
  const value = ref.trim()
  const result = isUuid(value)
    ? await db.query(`select ${STAGE_COLUMNS} from lab_stages where id = $1`, [value])
    : await db.query(`select ${STAGE_COLUMNS} from lab_stages where lower(name) = lower($1)`, [value])
  return rows<Stage>(result)[0] ?? null
}

/** Where a new subject lands: the first planned stage, or failing that the first stage. */
export const defaultStage = async (db: Db = pool()): Promise<Stage | null> => {
  const result = await db.query(
    `select ${STAGE_COLUMNS} from lab_stages
      order by (category = 'planned') desc, position, name
      limit 1`,
  )
  return rows<Stage>(result)[0] ?? null
}

export const unknownStage = async (ref: string) => {
  const stages = await listStages()
  return fail('validation_failed', `No stage ${ref}. Valid: ${stages.map((s) => s.name).join(' | ')}.`, {
    field: 'stage',
    valid: stages.map((s) => s.name),
  })
}

export const createStage = async (input: {
  name: string
  category: StageCategory
  color?: string
  position?: number
}): Promise<Outcome<Stage>> => {
  try {
    const result = await pool().query(
      `insert into lab_stages (name, category, color, position)
       values ($1, $2, coalesce($3, '#8a8792'),
               coalesce($4, (select coalesce(max(position) + 1, 0) from lab_stages)))
       returning ${STAGE_COLUMNS}`,
      [input.name, input.category, input.color ?? null, input.position ?? null],
    )
    return { ok: true, value: rows<Stage>(result)[0]! }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A stage called ${input.name} already exists.`) }
    throw error
  }
}

export const updateStage = async (
  id: string,
  patch: { name?: string; category?: StageCategory; color?: string; position?: number },
): Promise<Outcome<Stage>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No stage ${id}.`) }
  try {
    const result = await pool().query(
      `update lab_stages set
         name     = coalesce($2, name),
         category = coalesce($3, category),
         color    = coalesce($4, color),
         position = coalesce($5, position)
       where id = $1
       returning ${STAGE_COLUMNS}`,
      [id, patch.name ?? null, patch.category ?? null, patch.color ?? null, patch.position ?? null],
    )
    const stage = rows<Stage>(result)[0]
    return stage ? { ok: true, value: stage } : { ok: false, response: fail('not_found', `No stage ${id}.`) }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A stage called ${patch.name} already exists.`) }
    throw error
  }
}

/**
 * Refused while any subject — archived ones included — is in the stage:
 * deleting it would have to put them somewhere, and guessing where is worse
 * than asking the admin to move them first.
 */
export const deleteStage = async (id: string): Promise<Outcome<{ id: string; deleted: true }>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No stage ${id}.`) }
  return transaction(async (client) => {
    const stage = rows<Stage>(await client.query(`select ${STAGE_COLUMNS} from lab_stages where id = $1 for update`, [id]))[0]
    if (!stage) return { ok: false, response: fail('not_found', `No stage ${id}.`) }

    const inUse = rows<{ n: number }>(await client.query('select count(*)::int as n from subjects where stage_id = $1', [id]))[0]?.n ?? 0
    if (inUse > 0) {
      return {
        ok: false,
        response: fail(
          'stage_in_use',
          `${inUse} subject${inUse === 1 ? '' : 's'} (archived ones included) ${inUse === 1 ? 'is' : 'are'} in ${stage.name}. Move them to another stage first.`,
          { subjects: inUse },
        ),
      }
    }

    const remaining = rows<{ n: number }>(await client.query('select count(*)::int as n from lab_stages'))[0]?.n ?? 0
    if (remaining <= 1) return { ok: false, response: fail('conflict', 'The board needs at least one stage.') }

    try {
      await client.query('savepoint stage_delete')
      await client.query('delete from lab_stages where id = $1', [id])
    } catch (error) {
      // A subject filed into the stage between the count and the delete: the
      // foreign key refuses, and that is the same answer as the count's.
      if ((error as { code?: string }).code !== '23503') throw error
      await client.query('rollback to savepoint stage_delete')
      return {
        ok: false,
        response: fail('stage_in_use', `A subject is in ${stage.name}. Move it to another stage first.`, { subjects: 1 }),
      }
    }
    return { ok: true, value: { id, deleted: true as const } }
  })
}

/** `ids` must name every stage exactly once; the order given becomes the order. */
export const reorderStages = async (ids: string[]): Promise<Outcome<Stage[]>> =>
  transaction(async (client) => {
    const current = rows<{ id: string }>(await client.query('select id from lab_stages for update'))
    const known = new Set(current.map((s) => s.id))
    const given = new Set(ids)
    if (given.size !== ids.length || given.size !== known.size || ids.some((id) => !known.has(id))) {
      return { ok: false, response: fail('validation_failed', `Send every stage id exactly once (${known.size} stages).`) }
    }
    await client.query(
      `update lab_stages s set position = o.ord - 1
         from unnest($1::uuid[]) with ordinality as o(id, ord)
        where s.id = o.id`,
      [ids],
    )
    return { ok: true, value: await listStages(client) }
  })

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_COLUMNS = 'id, name, color, position'

export const listTags = async (db: Db = pool()): Promise<Tag[]> =>
  rows<Tag>(await db.query(`select ${TAG_COLUMNS} from lab_tags order by position, name`))

/** Tags by name (any case) or id. Unknown ones are returned so the caller can say which. */
export const findTags = async (refs: readonly string[], db: Db = pool()): Promise<{ tags: Tag[]; unknown: string[] }> => {
  const wanted = [...new Set(refs.map((r) => r.trim()).filter(Boolean))]
  if (wanted.length === 0) return { tags: [], unknown: [] }
  const result = await db.query(
    `select ${TAG_COLUMNS} from lab_tags
      where name = any(select lower(x) from unnest($1::text[]) x) or id::text = any($1::text[])`,
    [wanted],
  )
  const tags = rows<Tag>(result)
  const unknown = wanted.filter((ref) => !tags.some((t) => t.id === ref || t.name === ref.toLowerCase()))
  return { tags, unknown }
}

export const unknownTags = async (unknown: string[]) => {
  const tags = await listTags()
  return fail(
    'validation_failed',
    `No tag ${unknown.join(', ')}. Tags are curated by an administrator. Valid: ${tags.map((t) => t.name).join(' | ') || '(none yet)'}.`,
    { field: 'tags', valid: tags.map((t) => t.name) },
  )
}

export const createTag = async (input: { name: string; color?: string; position?: number }): Promise<Outcome<Tag>> => {
  try {
    const result = await pool().query(
      `insert into lab_tags (name, color, position)
       values (lower(btrim($1)), coalesce($2, '#8a8792'), coalesce($3, (select coalesce(max(position) + 1, 0) from lab_tags)))
       returning ${TAG_COLUMNS}`,
      [input.name, input.color ?? null, input.position ?? null],
    )
    return { ok: true, value: rows<Tag>(result)[0]! }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A tag called ${input.name} already exists.`) }
    throw error
  }
}

export const updateTag = async (
  id: string,
  patch: { name?: string; color?: string; position?: number },
): Promise<Outcome<Tag>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
  try {
    const result = await pool().query(
      `update lab_tags set
         name     = coalesce(lower(btrim($2)), name),
         color    = coalesce($3, color),
         position = coalesce($4, position)
       where id = $1
       returning ${TAG_COLUMNS}`,
      [id, patch.name ?? null, patch.color ?? null, patch.position ?? null],
    )
    const tag = rows<Tag>(result)[0]
    return tag ? { ok: true, value: tag } : { ok: false, response: fail('not_found', `No tag ${id}.`) }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A tag called ${patch.name} already exists.`) }
    throw error
  }
}

/** Deleting a tag takes it off every subject; the subjects themselves are untouched. */
export const deleteTag = async (id: string): Promise<Outcome<{ id: string; deleted: true; subjects: number }>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
  return transaction(async (client) => {
    const used = rows<{ n: number }>(await client.query('select count(*)::int as n from subject_tags where tag_id = $1', [id]))[0]?.n ?? 0
    const result = await client.query('delete from lab_tags where id = $1', [id])
    if (!result.rowCount) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
    return { ok: true, value: { id, deleted: true as const, subjects: used } }
  })
}
