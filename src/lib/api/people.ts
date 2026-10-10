import { pool } from '@/lib/db/client'
import { withLabFields } from './task-lab-fields'

/**
 * A user as the rest of the workspace sees one: enough to name them and pick
 * them, none of the administration (`/users` keeps role, keys and lifecycle).
 */
export type Person = {
  id: string
  email: string
  name: string
  active: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const selectPerson = `
  select u.id, u.email,
         coalesce(nullif(trim(p.display_name), ''), u.email) as name,
         (u.deleted_at is null and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()) as active
    from app_users u
    left join user_profiles p on p.id = u.id`

/** Everyone a task can be assigned to. Removed and suspended users are left out. */
export const listPeople = async (): Promise<Person[]> => {
  const result = await pool().query<Person>(
    `${selectPerson}
      where u.deleted_at is null and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
      order by lower(coalesce(nullif(trim(p.display_name), ''), u.email))`,
  )
  return result.rows
}

export const peopleByIds = async (ids: readonly string[]): Promise<Map<string, Person>> => {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const result = await pool().query<Person>(`${selectPerson} where u.id = any($1::uuid[])`, [unique])
  return new Map(result.rows.map((person) => [person.id, person]))
}

export type AssigneeLookup =
  | { ok: true; person: Person }
  | { ok: false; code: 'not_found' | 'validation_failed'; error: string }

/**
 * Who `--assignee` names. `me` is the human behind the caller — for an agent,
 * the owner of its key — so an agent filing work files it for its human.
 * Otherwise a user id, an email, or a display name; a name two people share is
 * refused rather than guessed.
 */
export const resolveAssignee = async (raw: string, callerUserId: string): Promise<AssigneeLookup> => {
  const value = raw.trim()
  if (value === '' || value.toLowerCase() === 'me') {
    const person = (await peopleByIds([callerUserId])).get(callerUserId)
    return person
      ? { ok: true, person }
      : { ok: false, code: 'not_found', error: 'The calling user no longer exists.' }
  }

  const result = await pool().query<Person>(
    UUID.test(value)
      ? `${selectPerson} where u.id = $1::uuid`
      : `${selectPerson}
          where lower(u.email) = lower($1)
             or lower(nullif(trim(p.display_name), '')) = lower($1)`,
    [value],
  )
  const matches = result.rows
  if (matches.length === 0) {
    return { ok: false, code: 'not_found', error: `No user ${value}. Name one by email, display name or id.` }
  }
  const exact = matches.filter((person) => person.email.toLowerCase() === value.toLowerCase())
  const candidates = exact.length === 1 ? exact : matches
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'validation_failed',
      error: `${value} names ${candidates.length} users (${candidates.map((p) => p.email).join(', ')}). Use an email.`,
    }
  }
  const [person] = candidates
  if (!person) return { ok: false, code: 'not_found', error: `No user ${value}.` }
  if (!person.active) {
    return { ok: false, code: 'validation_failed', error: `${person.name} is no longer active and cannot be assigned work.` }
  }
  return { ok: true, person }
}

/**
 * Names each row's assignee. The label is read live rather than stored, so a
 * renamed user is renamed on every task at once — unlike `actor_id`, which is
 * history and keeps the name it was written under.
 */
export const withAssignees = async <T extends object>(
  rows: readonly T[],
): Promise<(T & { assignee: Person | null })[]> => {
  const idOf = (row: T) => {
    const id = (row as { assignee_user_id?: unknown }).assignee_user_id
    return typeof id === 'string' ? id : null
  }
  const people = await peopleByIds(rows.map((row) => idOf(row) ?? ''))
  // Every task response passes through here, so this is where the raw
  // subject_id and handoff_* columns become `subject` and `handoff`.
  return withLabFields(rows.map((row) => ({ ...row, assignee: people.get(idOf(row) ?? '') ?? null })))
}

export const withAssignee = async <T extends object>(row: T): Promise<T & { assignee: Person | null }> =>
  (await withAssignees([row]))[0]!
