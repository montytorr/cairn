import { z } from 'zod'
import { taskPriority, taskStatus, taskType } from '@/schemas/task'
import { normalizeHandoffStatus, STAGE_CATEGORIES, WRITABLE_SUBJECT_NOTE_KINDS } from './lab-shape'

/** Request bodies and queries for the Lab routes (docs/lab.md). */

const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, like #6b7fa6.')
  .transform((v) => v.toLowerCase())

const title = z.string().trim().min(1).max(300)
const body = z.string().max(200_000)
const conclusion = z.string().trim().min(1).max(20_000)
/** A stage by name (any case) or id. */
const stageRef = z.string().trim().min(1).max(80)
const tagNames = z.array(z.string().trim().min(1).max(40)).max(20)
/** `me`, a user id, an email or a display name. */
const owner = z.string().trim().min(1).max(320)
/** A Cairn project by key or id. */
const projectRef = z.string().trim().min(1).max(60)

export const labSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** A project key or id; null goes back to the default (created on first todo as LT). */
    homeProject: projectRef.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send enabled, homeProject or both.')

export const createSubjectSchema = z.object({
  title,
  body: body.optional(),
  stage: stageRef.optional(),
  tags: tagNames.optional(),
  owner: owner.nullable().optional(),
  project: projectRef.nullable().optional(),
  /** Only needed when filing straight into a completed or dropped stage. */
  conclusion: conclusion.optional(),
  /** Admins only: the importer keeps Croft's numbers. */
  number: z.number().int().min(1).max(9_999_999).optional(),
})

/** No defaults: a PATCH never rewrites a field its caller did not send. */
export const updateSubjectSchema = z
  .object({
    title,
    body: body.nullable(),
    stage: stageRef,
    conclusion: conclusion.nullable(),
    tags: tagNames,
    owner: owner.nullable(),
    project: projectRef.nullable(),
    position: z.number().int().min(-1_000_000).max(1_000_000),
    archived: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

const list = z.string().trim().min(1).max(400)

export const listSubjectsQuery = z.object({
  stage: list.optional(),
  category: list.optional(),
  tag: list.optional(),
  owner: z.string().trim().min(1).max(320).optional(),
  project: list.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const createSubjectNoteSchema = z.object({
  note: z.string().trim().min(1).max(100_000),
  kind: z.enum(WRITABLE_SUBJECT_NOTE_KINDS).default('note'),
})

export const listSubjectNotesQuery = z.object({
  kind: list.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const humanNoteSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
})

export const createSubjectTodoSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).optional(),
  priority: taskPriority.default('medium'),
  type: taskType.default('chore'),
  /** A todo is on the list to do, so it starts at `todo` rather than the backlog. */
  status: taskStatus.default('todo'),
  assignee: owner.optional(),
  /** File it under an existing task (a ref or uuid). */
  parent: z.string().min(2).max(60).optional(),
})

export const listTodosQuery = z.object({
  status: list.optional(),
})

export const mentionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const createStageSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(STAGE_CATEGORIES),
  color: colour.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

export const updateStageSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    category: z.enum(STAGE_CATEGORIES),
    color: colour,
    position: z.number().int().min(0).max(10_000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((v) => v.toLowerCase())

export const createTagSchema = z.object({
  name: tagName,
  color: colour.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

export const updateTagSchema = z
  .object({ name: tagName, color: colour, position: z.number().int().min(0).max(10_000) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

// ---------------------------------------------------------------------------
// Hand-off
// ---------------------------------------------------------------------------

export const HANDOFF_TRACKER = /^[a-z][a-z0-9-]{1,31}$/
export const HANDOFF_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

/** Not whitespace or a control character anywhere: a ref is one token. */
const NO_SPACE_OR_CONTROL = /^[^\s\u0000-\u001f\u007f]+$/

export const handoffSchema = z.object({
  tracker: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(HANDOFF_TRACKER, 'expected a tracker name like cairn or github (2-32 characters, a letter first)')),
  ref: z.string().trim().min(1).max(200).regex(NO_SPACE_OR_CONTROL, 'A ref has no whitespace or control characters.'),
  /** Where the task lives there. http(s); required (https) for a cairn tracker. */
  url: z.string().trim().max(2000).regex(/^https?:\/\//i, 'expected an http(s) URL').nullable().optional(),
  /**
   * What the tracker says now, lower-cased; `closed`/`completed` read as done and
   * `canceled` as cancelled. done or cancelled ends the hand-off and closes the task.
   */
  status: z.string().trim().min(1).max(40).transform(normalizeHandoffStatus).optional(),
  resolution: z.string().trim().max(20_000).optional(),
  resolutionKind: z.string().trim().min(1).max(40).optional(),
})

export const listHandoffsQuery = z.object({
  state: z.enum(['open', 'ended', 'all']).default('open'),
  tracker: z.string().trim().min(1).max(32).optional(),
  project: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

/** Project defaults: both, or neither (null clears both). */
export const projectHandoffFields = {
  handoffTracker: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(HANDOFF_TRACKER, 'expected a tracker name like cairn or github'))
    .nullable()
    .optional(),
  handoffTarget: z
    .string()
    .trim()
    .regex(HANDOFF_TARGET, 'expected a target like PROJ or owner/repo (1-100 characters)')
    .nullable()
    .optional(),
}

/** The refinement for project bodies carrying hand-off defaults. */
export const handoffPairProblem = (value: { handoffTracker?: string | null; handoffTarget?: string | null }) => {
  const touched = value.handoffTracker !== undefined || value.handoffTarget !== undefined
  if (!touched) return null
  return (value.handoffTracker == null) !== (value.handoffTarget == null)
    ? 'A hand-off default needs both handoffTracker and handoffTarget, or neither (null clears both).'
    : null
}
