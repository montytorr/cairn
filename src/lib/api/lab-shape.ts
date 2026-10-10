import { createHash } from 'node:crypto'
import { fail } from './response'

/**
 * The Lab's pure rules and shapes (CAIRN-366, docs/lab.md). Nothing here
 * touches the database, so every rule is testable on its own and every route
 * and list can import it without pulling in the writers.
 */

export const STAGE_CATEGORIES = ['planned', 'active', 'completed', 'dropped'] as const
export type StageCategory = (typeof STAGE_CATEGORIES)[number]

export const CONCLUDING_CATEGORIES: readonly StageCategory[] = ['completed', 'dropped']
export const isConcluding = (category: StageCategory) => CONCLUDING_CATEGORIES.includes(category)

/** `stage` is the server's own: written with every move, never posted. */
export const SUBJECT_NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff', 'stage'] as const
export type SubjectNoteKind = (typeof SUBJECT_NOTE_KINDS)[number]
export const WRITABLE_SUBJECT_NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff'] as const

/** The key subjects are addressed by, reserved in the project-key namespace. */
export const LAB_KEY = 'LAB'
/** The home project created for todos of subjects without a project. */
export const LAB_HOME_KEY = 'LT'

export const subjectRef = (number: number) => `${LAB_KEY}-${number}`

/** Accepts `LAB-12`, `lab-12` or `12`. */
export const parseSubjectRef = (raw: string): number | null => {
  const value = (() => {
    try {
      return decodeURIComponent(raw).trim()
    } catch {
      return raw.trim()
    }
  })()
  const match = /^(?:lab-)?(\d{1,7})$/i.exec(value)
  if (!match) return null
  const number = Number(match[1])
  return number > 0 ? number : null
}

/** A query that is exactly a subject ref: `LAB-12`, any case. Bare numbers are tasks' (search.ts). */
export const subjectRefQuery = (q: string): number | null => {
  const match = /^\s*lab-(\d{1,7})\s*$/i.exec(q)
  return match ? Number(match[1]) : null
}

/** The refusal for a project key a project may not take. */
export const reservedKeyRefusal = (key: string | undefined) =>
  key?.toUpperCase() === LAB_KEY
    ? fail('validation_failed', `${LAB_KEY} is reserved for Lab subjects (LAB-12); choose another key.`, {
        field: 'key',
      })
    : null

// ---------------------------------------------------------------------------
// Stages and conclusions
// ---------------------------------------------------------------------------

/**
 * A subject entering a completed or dropped stage must say what was learned.
 *
 * Checked only when the caller moves the stage or touches the conclusion: a
 * subject already sitting in a concluding stage without one (an admin changed
 * the stage's category afterwards) can still have its title fixed.
 */
export const conclusionMissing = (input: {
  stageChanging: boolean
  conclusionTouched: boolean
  targetCategory: StageCategory
  conclusion: string | null | undefined
}): boolean =>
  (input.stageChanging || input.conclusionTouched) &&
  isConcluding(input.targetCategory) &&
  !(input.conclusion ?? '').trim()

/**
 * When the subject was concluded: set on the way into a concluding stage,
 * kept between concluding stages, cleared on the way out.
 */
export const nextConcludedAt = (input: {
  fromCategory: StageCategory
  toCategory: StageCategory
  concludedAt: string | null
  now: string
}): string | null => {
  if (!isConcluding(input.toCategory)) return null
  if (!isConcluding(input.fromCategory)) return input.now
  return input.concludedAt ?? input.now
}

export const conclusionRequired = (stage: { name: string; category: StageCategory }, ref = 'LAB-<n>') =>
  fail(
    'conclusion_required',
    `${stage.name} is a ${stage.category} stage: say what was learned. Send a conclusion with the move ` +
      `(cairn subject stage ${ref} "${stage.name}" --conclusion "<what we learned>").`,
    { stage: stage.name, category: stage.category },
  )

/** `to explore → exploring` */
export const stageNoteText = (from: string, to: string) => `${from} → ${to}`

const hash32 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)

/** A retry of the same kind and text is one note. Same formula as Croft's, so imports keep theirs. */
export const noteContentHash = (kind: string, note: string) => hash32(`${kind}\n${note}`)

/** Stage notes are never deduplicated — A → B → A → B is three moves — so the moment is hashed too. */
export const stageNoteHash = (from: string, to: string, at: string) => hash32(`stage\n${from}\n${to}\n${at}`)

// ---------------------------------------------------------------------------
// Hand-off
// ---------------------------------------------------------------------------

export const TERMINAL_HANDOFF_STATUSES = ['done', 'cancelled'] as const

/** The raw columns, for a select on `tasks`. */
export const HANDOFF_COLUMNS = 'handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at'

export type Handoff = {
  tracker: string
  ref: string
  url: string | null
  status: string | null
  synced_at: string | null
}

type HandoffColumns = {
  handoff_tracker?: unknown
  handoff_ref?: unknown
  handoff_url?: unknown
  handoff_status?: unknown
  handoff_synced_at?: unknown
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
const stamp = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value))

/**
 * A tracker's word for its status, as Cairn records it: lower-cased, with the
 * spellings trackers use for "ended" folded into Cairn's two, so `Done`,
 * `closed` or `canceled` ends the hand-off the way `done` does.
 */
const HANDOFF_STATUS_SYNONYMS: Record<string, string> = {
  closed: 'done',
  completed: 'done',
  complete: 'done',
  canceled: 'cancelled',
}

export const normalizeHandoffStatus = (status: string) => {
  const lower = status.trim().toLowerCase()
  return HANDOFF_STATUS_SYNONYMS[lower] ?? lower
}

export const isTerminalHandoff =(status: string | null | undefined): status is 'done' | 'cancelled' =>
  Boolean(status) && (TERMINAL_HANDOFF_STATUSES as readonly string[]).includes(status as string)

/** The hand-off a task row carries, or null. */
export const handoffOf = (source: object | null | undefined): Handoff | null => {
  const row = source as HandoffColumns | null | undefined
  const tracker = text(row?.handoff_tracker)
  const ref = text(row?.handoff_ref)
  if (!tracker || !ref) return null
  return {
    tracker,
    ref,
    url: text(row?.handoff_url),
    status: text(row?.handoff_status),
    synced_at: stamp(row?.handoff_synced_at),
  }
}

/** Open: the other tracker has not ended it, so it owns the status. */
export const isHandedOff = (row: object | null | undefined) => {
  const handoff = handoffOf(row)
  return handoff !== null && !isTerminalHandoff(handoff.status)
}

/**
 * 409 `handed_off` for a status change, claim or release on a task whose
 * hand-off is open. Edits to its title, body and the rest never come here.
 */
export const refuseHandedOff = (row: object | null | undefined, taskRef: string): Response | null => {
  const handoff = handoffOf(row)
  if (!handoff || isTerminalHandoff(handoff.status)) return null
  return fail(
    'handed_off',
    `${taskRef} was handed off to ${handoff.tracker} as ${handoff.ref}${handoff.url ? ` (${handoff.url})` : ''}, ` +
      `which owns its status now: work it there (cairn sync brings the outcome back), or take it back: ` +
      `cairn handoff ${taskRef} --undo`,
    { tracker: handoff.tracker, handoffRef: handoff.ref, url: handoff.url },
  )
}

/** Raw `handoff_*` columns become the `handoff` object; a row without them passes through. */
export const withHandoff = <T extends object>(row: T): T & { handoff?: Handoff | null } => {
  if (!row || typeof row !== 'object' || !('handoff_ref' in row)) return row
  const {
    handoff_tracker: _tracker,
    handoff_ref: _ref,
    handoff_url: _url,
    handoff_status: _status,
    handoff_synced_at: _syncedAt,
    ...rest
  } = row as HandoffColumns & Record<string, unknown>
  return { ...rest, handoff: handoffOf(row as HandoffColumns) } as unknown as T & { handoff: Handoff | null }
}

/** `LT-41 done: <resolution>`: what an ended hand-off leaves in the subject's log. */
export const handoffOutcomeNote = (ref: string, status: string, resolution: string | null | undefined) =>
  `${ref} ${status}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/** Keyed on tracker, ref and status, so a resolution revised there adds no second line. */
export const handoffOutcomeHash = (tracker: string, ref: string, status: string) =>
  hash32(`${tracker}\n${ref}\n${status}`)

/** What closing a handed-off task says about the task that ended it. */
export const closedInResolution = (tracker: string, ref: string, resolution: string | null | undefined) =>
  `Closed in ${tracker} as ${ref}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/** The tracker's kind when Cairn has it; `verified` otherwise, since the work was checked there. */
export const closedInKind = (kind: string | null | undefined, known: readonly string[]) =>
  kind && known.includes(kind) ? kind : 'verified'

/**
 * A `cairn` hand-off must say which Cairn holds the task: a bare `KDP-41`
 * names a task on any instance with a KDP project (knowledge
 * croft-cairn-shared-work-boundary). Null when the pair is acceptable.
 */
export const handoffUrlProblem = (tracker: string, url: string | null | undefined): string | null =>
  tracker === 'cairn' && !(url && /^https:\/\//i.test(url))
    ? 'A cairn hand-off needs the destination task\'s absolute https URL (url), so it says which Cairn ' +
      'instance holds it: https://<instance>/projects/<KEY>/tasks/<n>.'
    : null
