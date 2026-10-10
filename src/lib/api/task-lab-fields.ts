import { pool } from '@/lib/db/client'
import { isLabEnabled } from './lab-settings'
import { subjectRef, withHandoff, type Handoff } from './lab-shape'

/**
 * What a task response says about the Lab and hand-off (docs/lab.md):
 *
 *  - `subject: { ref, title } | null` while the Lab is on, absent while off;
 *  - `handoff: Handoff | null`, always, when the row carried the columns.
 *
 * The raw `subject_id` and `handoff_*` columns never leave. Rows that did not
 * select them pass through untouched, and a row already shaped is not shaped
 * twice, so every response path can call this without coordinating.
 */
export type LabTaskFields = { subject?: { ref: string; title: string } | null; handoff?: Handoff | null }

export const withLabFields = async <T extends object>(rows: readonly T[]): Promise<(T & LabTaskFields)[]> => {
  const carrying = rows.filter((row) => row && typeof row === 'object' && 'subject_id' in row)
  const ids = [
    ...new Set(
      carrying
        .map((row) => (row as { subject_id?: unknown }).subject_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ]
  const labOn = carrying.length > 0 ? await isLabEnabled() : false
  const subjects = new Map<string, { ref: string; title: string }>()
  if (labOn && ids.length > 0) {
    const { rows: found } = await pool().query<{ id: string; number: number; title: string }>(
      'select id, number, title from subjects where id = any($1::uuid[])',
      [ids],
    )
    for (const s of found) subjects.set(s.id, { ref: subjectRef(s.number), title: s.title })
  }

  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row as T & LabTaskFields
    let shaped = withHandoff(row) as T & LabTaskFields
    if ('subject_id' in shaped) {
      const { subject_id: subjectId, ...rest } = shaped as T & { subject_id?: unknown }
      shaped = rest as T & LabTaskFields
      if (labOn) {
        shaped = {
          ...shaped,
          subject: typeof subjectId === 'string' ? (subjects.get(subjectId) ?? null) : null,
        }
      }
    }
    return shaped
  })
}

export const withLabField = async <T extends object>(row: T): Promise<T & LabTaskFields> =>
  (await withLabFields([row]))[0]!
