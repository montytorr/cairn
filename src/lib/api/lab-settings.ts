import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import type { Actor } from './auth'
import { fail } from './response'
import { LAB_HOME_KEY, LAB_KEY } from './lab-shape'

/**
 * The Lab's switch, per instance and off by default (071's `lab_settings`).
 *
 * Read on most requests, so it is cached in process for 30 seconds the way
 * branding is (066); a write here invalidates it at once, and another
 * process notices within the TTL.
 */

export type LabSettings = {
  enabled: boolean
  home_project: { id: string; key: string; title: string } | null
  updated_at: string | null
}

const TTL_MS = 30_000
const CACHE = Symbol.for('cairn.lab-settings')
type Cached = { at: number; value: LabSettings }
const store = globalThis as typeof globalThis & { [CACHE]?: Cached }

const OFF: LabSettings = { enabled: false, home_project: null, updated_at: null }

/** 42P01, undefined_table: a database that has not run 071 has no Lab, which is what off means. */
const isMissingTable = (error: unknown) => (error as { code?: string } | null)?.code === '42P01'

const read = async (): Promise<LabSettings> => {
  try {
    const { rows } = await pool().query(
      `select s.enabled, s.updated_at, p.id as project_id, p.key as project_key, p.title as project_title
         from lab_settings s
         left join projects p on p.id = s.home_project_id
        where s.id`,
    )
    const row = (normalizeDatabaseValue(rows) as Record<string, unknown>[])[0]
    if (!row) return OFF
    return {
      enabled: row.enabled === true,
      home_project: row.project_id
        ? { id: String(row.project_id), key: String(row.project_key), title: String(row.project_title) }
        : null,
      updated_at: (row.updated_at as string | null) ?? null,
    }
  } catch (error) {
    // Only a missing table means off. Anything else — a pool error, a
    // failover — is an error: answering "off" would hide the Lab from
    // everyone until the cache expired, which reads as data loss.
    if (isMissingTable(error)) return OFF
    throw error
  }
}

/** Cached for 30 seconds once read. A failed read is never cached: the next request tries again. */
export const getLabSettings = async (): Promise<LabSettings> => {
  const cached = store[CACHE]
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value
  const value = await read()
  store[CACHE] = { at: Date.now(), value }
  return value
}

export const invalidateLabSettings = () => {
  delete store[CACHE]
}

export const isLabEnabled = async () => (await getLabSettings()).enabled

/** Every Lab route's first line after authentication. */
export const refuseLabDisabled = async (): Promise<Response | null> =>
  (await isLabEnabled())
    ? null
    : fail('lab_disabled', 'The Lab is not enabled on this instance. An administrator turns it on in Settings.')

/** The project holding `LAB`, live or retired, if any: the Lab cannot be turned on while one does. */
export const projectHoldingLabKey = async (): Promise<{ id: string; key: string } | null> => {
  const { rows } = await pool().query<{ id: string; key: string }>(
    `select id, key from projects where key = $1
     union all
     select f.project_id, p.key from project_former_keys f join projects p on p.id = f.project_id where f.key = $1
     limit 1`,
    [LAB_KEY],
  )
  return rows[0] ?? null
}

/**
 * Writes the settings. `homeProject` is an already-resolved project id, or
 * null to go back to the default. Turning the Lab on also adds the LAB key
 * reservation check that 071 could not add on an instance that had a LAB
 * project then.
 */
export const writeLabSettings = async (
  actor: Actor,
  patch: { enabled?: boolean; homeProjectId?: string | null },
): Promise<LabSettings & { warning?: string }> => {
  await transaction(async (client) => {
    const sets: string[] = ['updated_at = now()', 'updated_by = $1']
    const values: unknown[] = [actor.userId]
    if (patch.enabled !== undefined) {
      values.push(patch.enabled)
      sets.push(`enabled = $${values.length}`)
    }
    if (patch.homeProjectId !== undefined) {
      values.push(patch.homeProjectId)
      sets.push(`home_project_id = $${values.length}`)
    }
    await client.query(`insert into lab_settings (id) values (true) on conflict (id) do nothing`)
    await client.query(`update lab_settings set ${sets.join(', ')} where id`, values)
  })
  invalidateLabSettings()
  const settings = await getLabSettings()
  if (!patch.enabled) return settings

  // After the switch is written, never inside its transaction: a reservation
  // that cannot be added must not undo turning the Lab on. The API's own
  // refusal of LAB holds either way, so this is a warning, not a failure.
  const warning = await reserveLabKey()
  return warning ? { ...settings, warning } : settings
}

/** Adds the database's LAB reservation; a warning when it could not be added. Never throws. */
export const reserveLabKey = async (): Promise<string | undefined> => {
  try {
    const { rows } = await pool().query<{ outcome: string }>('select cairn_lab_reserve_key() as outcome')
    const outcome = rows[0]?.outcome ?? 'failed: no answer'
    if (outcome === 'reserved') return undefined
    const warning =
      outcome === 'key_in_use'
        ? 'A project holds LAB, so the database reservation was not added; the API still refuses LAB as a key.'
        : `The database reservation of LAB could not be added (${outcome.replace(/^failed: /, '')}); the API still refuses LAB as a key.`
    console.warn('[lab] reserve LAB:', outcome)
    return warning
  } catch (error) {
    console.warn('[lab] reserve LAB:', error instanceof Error ? error.message : error)
    return 'The database reservation of LAB could not be added; the API still refuses LAB as a key.'
  }
}

/**
 * Records the home project, unless one is already recorded (a race with
 * another first todo): returns whichever is recorded afterwards.
 */
export const recordHomeProject = async (projectId: string): Promise<string> => {
  const { rows } = await pool().query<{ home_project_id: string }>(
    `update lab_settings set home_project_id = coalesce(home_project_id, $1), updated_at = now()
      where id returning home_project_id`,
    [projectId],
  )
  invalidateLabSettings()
  return rows[0]?.home_project_id ?? projectId
}

export { LAB_HOME_KEY }
