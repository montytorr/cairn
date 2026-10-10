import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import {
  buildSubjectStoragePath,
  removeAttachments,
  sanitizeFilename,
  sha256,
  signUrls,
  validateUpload,
  writeAttachment,
} from '@/lib/attachments'
import type { Actor } from './auth'
import { fail } from './response'
import { isLabAdmin, isUuid, type Outcome } from './lab-admin'

/**
 * People's notes and files on a subject (docs/lab.md; Croft's 075).
 *
 * A note is a person's: free markdown, edited only by its author (the human
 * behind a key counts as the author of what their agent wrote), deleted by
 * the author or an administrator. Files live in the store task files use.
 */

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

export type HumanNote = {
  id: string
  body: string
  author: { id: string; name: string } | null
  actor_type: string
  actor_id: string
  created_at: string
  updated_at: string
}

const HUMAN_NOTE_SELECT = `
  select n.id, n.body, n.user_id, n.actor_type, n.actor_id, n.created_at, n.updated_at,
         case when u.id is null then null
              else json_build_object('id', u.id, 'name', coalesce(nullif(trim(p.display_name), ''), u.email))
         end as author
    from subject_human_notes n
    left join app_users u on u.id = n.user_id
    left join user_profiles p on p.id = u.id`

type HumanNoteRow = HumanNote & { user_id: string | null }
const toNote = ({ user_id: _user, ...note }: HumanNoteRow): HumanNote => note

export const listHumanNotes = async (subjectId: string): Promise<HumanNote[]> =>
  rows<HumanNoteRow>(
    await pool().query(`${HUMAN_NOTE_SELECT} where n.subject_id = $1 order by n.created_at desc, n.id desc`, [subjectId]),
  ).map(toNote)

const findHumanNote = async (subjectId: string, id: string): Promise<HumanNoteRow | null> =>
  isUuid(id)
    ? (rows<HumanNoteRow>(
        await pool().query(`${HUMAN_NOTE_SELECT} where n.subject_id = $1 and n.id = $2`, [subjectId, id]),
      )[0] ?? null)
    : null

export const addHumanNote = async (actor: Actor, subjectId: string, body: string): Promise<HumanNote> => {
  const { rows: inserted } = await pool().query<{ id: string }>(
    `insert into subject_human_notes (subject_id, body, user_id, actor_type, actor_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [subjectId, body, actor.userId, actor.actorType, actor.actorId],
  )
  return toNote((await findHumanNote(subjectId, inserted[0]!.id))!)
}

const noSuchNote = (id: string) => fail('not_found', `No note ${id} on this subject.`)

export const editHumanNote = async (
  actor: Actor,
  subjectId: string,
  id: string,
  body: string,
): Promise<Outcome<HumanNote>> => {
  const note = await findHumanNote(subjectId, id)
  if (!note) return { ok: false, response: noSuchNote(id) }
  if (note.user_id !== actor.userId) {
    return { ok: false, response: fail('forbidden', 'Only its author can edit a note.') }
  }
  // The touch trigger moves updated_at; the subject's own updated_at moves
  // only for new notes (071), so an edit touches it here.
  await pool().query('update subject_human_notes set body = $3 where subject_id = $1 and id = $2', [subjectId, id, body])
  await pool().query('update subjects set updated_at = now() where id = $1', [subjectId])
  return { ok: true, value: toNote((await findHumanNote(subjectId, id))!) }
}

export const deleteHumanNote = async (
  actor: Actor,
  subjectId: string,
  id: string,
): Promise<Outcome<{ id: string; deleted: true }>> => {
  const note = await findHumanNote(subjectId, id)
  if (!note) return { ok: false, response: noSuchNote(id) }
  if (note.user_id !== actor.userId && !isLabAdmin(actor)) {
    return { ok: false, response: fail('forbidden', 'Only its author or an administrator can delete a note.') }
  }
  await pool().query('delete from subject_human_notes where subject_id = $1 and id = $2', [subjectId, id])
  await pool().query('update subjects set updated_at = now() where id = $1', [subjectId])
  return { ok: true, value: { id, deleted: true } }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type SubjectFileRow = {
  id: string
  subject_id: string
  filename: string
  mime_type: string
  size_bytes: number
  storage_path: string
  uploaded_by: string
  created_at: string
}

const FILE_COLUMNS = 'id, subject_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at'

/** The stable address markdown embeds (GET /api/v1/attachments/{id}/content). */
export const contentUrl = (id: string) => `/api/v1/attachments/${id}/content`

export const toAttachment = async (row: SubjectFileRow) => {
  const { previewUrl, downloadUrl } = await signUrls(row.storage_path, row.filename, row.mime_type)
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    preview_url: previewUrl,
    download_url: downloadUrl,
    content_url: contentUrl(row.id),
  }
}

export const listSubjectFiles = async (subjectId: string) =>
  Promise.all(
    rows<SubjectFileRow>(
      await pool().query(`select ${FILE_COLUMNS} from subject_attachments where subject_id = $1 order by created_at, id`, [
        subjectId,
      ]),
    ).map(toAttachment),
  )

/** A subject's file by id, wherever it is asked for. */
export const findSubjectFile = async (id: string): Promise<SubjectFileRow | null> =>
  isUuid(id)
    ? (rows<SubjectFileRow>(await pool().query(`select ${FILE_COLUMNS} from subject_attachments where id = $1`, [id]))[0] ?? null)
    : null

export const addSubjectFile = async (actor: Actor, subjectId: string, req: Request): Promise<Outcome<Awaited<ReturnType<typeof toAttachment>>>> => {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return { ok: false, response: fail('validation_failed', 'Send multipart/form-data with a "file" field.') }
  }
  const rejection = validateUpload({ name: file.name, type: file.type, size: file.size })
  if (rejection) {
    return {
      ok: false,
      response: fail('validation_failed', rejection.reason, rejection.valid ? { validTypes: rejection.valid } : undefined),
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const storagePath = buildSubjectStoragePath(subjectId, file.name)
  try {
    await writeAttachment(storagePath, bytes)
  } catch (error) {
    return { ok: false, response: fail('internal_error', `Upload failed: ${error instanceof Error ? error.message : error}`) }
  }

  try {
    const inserted = rows<SubjectFileRow>(
      await pool().query(
        `insert into subject_attachments
           (subject_id, filename, mime_type, size_bytes, storage_path, sha256, uploaded_by, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${FILE_COLUMNS}`,
        [subjectId, file.name.slice(0, 255) || sanitizeFilename(file.name), file.type, file.size, storagePath, sha256(bytes), actor.actorId, actor.userId],
      ),
    )[0]!
    return { ok: true, value: await toAttachment(inserted) }
  } catch (error) {
    // Do not leave an orphan object behind if the row insert fails.
    await removeAttachments([storagePath])
    throw error
  }
}

export const deleteSubjectFile = async (subjectId: string, id: string): Promise<Outcome<{ id: string; deleted: true }>> => {
  const row = await findSubjectFile(id)
  if (!row || row.subject_id !== subjectId) return { ok: false, response: fail('not_found', `No file ${id} on this subject.`) }
  // Object first: a failed row delete leaves a recoverable inconsistency,
  // a deleted row with a live object is an unreferenced leak.
  try {
    await removeAttachments([row.storage_path])
  } catch (error) {
    return { ok: false, response: fail('internal_error', `Storage delete failed: ${error instanceof Error ? error.message : error}`) }
  }
  await pool().query('delete from subject_attachments where id = $1', [id])
  return { ok: true, value: { id, deleted: true } }
}
