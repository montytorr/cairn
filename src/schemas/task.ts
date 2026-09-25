import { z } from 'zod'

/**
 * Single source of truth for Cairn's domain vocabulary.
 *
 * The API, the CLI, the OpenAPI spec and the UI all import from here, so a new
 * task type is added in exactly one place — plus a one-line migration to widen
 * the matching CHECK constraint.
 */

export const TASK_TYPES = ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] as const

/** Board order. The UI renders columns in this sequence. */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'doing',
  'in-review',
  'done',
  'cancelled',
] as const

/** Statuses that require a resolution before the API will accept the transition. */
export const TERMINAL_STATUSES = ['done', 'cancelled'] as const

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const

export const RESOLUTION_KINDS = [
  'fixed',
  /**
   * The fix was already there; this close is the record that somebody checked.
   *
   * Six tasks in one triage were closed after reading the current code and
   * finding the defect already gone. `fixed` was the only kind that fit and it
   * claims authorship of somebody else's commit — and makes the close
   * indistinguishable from one where nobody read anything.
   */
  'verified',
  'wont-fix',
  'duplicate',
  'not-reproducible',
  'superseded',
  'answered',
] as const

export const NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff'] as const

export const ACTOR_TYPES = ['human', 'agent'] as const

export const taskType = z.enum(TASK_TYPES)
export const taskStatus = z.enum(TASK_STATUSES)
export const taskPriority = z.enum(TASK_PRIORITIES)
export const resolutionKind = z.enum(RESOLUTION_KINDS)
export const noteKind = z.enum(NOTE_KINDS)

export type TaskType = z.infer<typeof taskType>
export type TaskStatus = z.infer<typeof taskStatus>
export type TaskPriority = z.infer<typeof taskPriority>
export type ResolutionKind = z.infer<typeof resolutionKind>
export type NoteKind = z.infer<typeof noteKind>

export const isTerminal = (s: TaskStatus): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(s)

/**
 * Field definitions WITHOUT defaults.
 *
 * This split is load-bearing. `.default()` survives `.partial()` — Zod's
 * ZodOptional wraps the ZodDefault rather than replacing it, so
 * `createTaskSchema.partial().parse({})` yields `{ type: 'feature' }`. Deriving
 * the PATCH schema that way made every update silently reset `type` and
 * `priority` to their defaults, quietly corrupting rows the caller never
 * mentioned. Defaults belong on the create schema only.
 */
const taskFields = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(100_000),
  type: taskType,
  status: taskStatus,
  priority: taskPriority,
  labels: z.array(z.string().min(1).max(50)).max(20),
  dueDate: z.string().date(),
})

/**
 * Types whose value is the body. A chore is often fully described by its
 * title; a bug or a spike with no body is not yet a report.
 */
export const NEEDS_BODY: readonly TaskType[] = ['bug', 'spike']

/** Below this a "body" is a restated title, which is what the rule exists to stop. */
export const MIN_BODY_CHARS = 40

export const createTaskSchema = taskFields
  .partial()
  .extend({
    title: z.string().min(1).max(300),
    type: taskType.default('feature'),
    status: taskStatus.default('backlog'),
    priority: taskPriority.default('medium'),
    labels: z.array(z.string().min(1).max(50)).max(20).default([]),
    /** File it under an existing task. A ref (`CAI-42`) or uuid. */
    parentRef: z.string().min(2).max(60).optional(),
    /**
     * File a bug or spike with no body on purpose — `cairn add --force-empty`.
     * The escape hatch has to be something the caller says, never a default.
     */
    forceEmpty: z.boolean().optional(),
  })
  /**
   * The bug/spike body rule, where every caller meets it (CAIRN-291).
   *
   * It lived only in the CLI, and there it worked: none filed empty since it
   * shipped, against 71 before. The API accepted an empty description, so the
   * UI, the MCP facade and any direct caller walked straight past it.
   */
  .superRefine((value, ctx) => {
    if (!NEEDS_BODY.includes(value.type) || value.forceEmpty) return
    if ((value.description ?? '').trim().length >= MIN_BODY_CHARS) return
    ctx.addIssue({
      code: 'custom',
      path: ['description'],
      message:
        `A ${value.type} needs a description of at least ${MIN_BODY_CHARS} characters: what happens, ` +
        'what you expected, and how to see it. If the title really is the whole story, send forceEmpty: true ' +
        '(cairn add --force-empty).',
    })
  })

/** Partial update. No defaults, so absent fields stay absent. */
export const updateTaskSchema = taskFields.partial().extend({
  resolution: z.string().max(100_000).optional(),
  resolutionKind: resolutionKind.optional(),
  /**
   * The task this one duplicates, as a ref or uuid. Only meaningful alongside
   * `resolutionKind: 'duplicate'`; the database refuses the pair otherwise.
   * `null` clears it.
   */
  duplicateOf: z.string().min(2).max(60).nullable().optional(),
  /** Re-parent, or `null` to lift it back to the top level. */
  parentRef: z.string().min(2).max(60).nullable().optional(),
  /**
   * Move the task to another project, by key or uuid. Per-project numbering
   * means the ref changes, so this is handled apart from the field updates.
   */
  project: z.string().min(1).max(60).optional(),
  /**
   * Additional projects this task also belongs to, by key. Replaces the set;
   * `[]` or `null` clears it. The home project is not one of these -- it keeps
   * the ref, and these only widen where the task appears.
   */
  alsoProjects: z.array(z.string().min(1).max(10)).max(20).nullable().optional(),
})

export const createNoteSchema = z.object({
  note: z.string().min(1).max(100_000),
  kind: noteKind.default('note'),
  facts: z.array(z.string().min(1).max(500)).max(50).optional(),
})

export const ACTIVITY_EVIDENCE_EVENTS = ['git_commit', 'git_push', 'run_result'] as const
export const activityEvidenceEvent = z.enum(ACTIVITY_EVIDENCE_EVENTS)

/**
 * Structured delivery evidence agents can attach to a task timeline.
 *
 * Every field was optional, so `{event:'git_commit'}` was accepted and stored a
 * row asserting that a commit happened while naming no commit. The CLI asks for
 * a sha positionally and so never produced one, but the CLI is not the
 * contract — the API is, and it is what the MCP facade and anything else writes
 * against. Evidence that cannot be checked is worse than no evidence, because
 * it still renders in the timeline as though something was proved.
 */
export const createActivityEvidenceSchema = z
  .object({
    event: activityEvidenceEvent,
    sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    repo: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(250).optional(),
    message: z.string().max(500).optional(),
    url: z.string().url().max(2_000).optional(),
    remote: z.string().min(1).max(250).optional(),
    command: z.string().min(1).max(2_000).optional(),
    status: z.enum(['passed', 'failed', 'skipped']).optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    // 4KB, not 50. Nothing reads this back — the timeline renders the status,
    // the command and the exit code — so it is kept for diagnosing a failure,
    // and a stored blob fifty times larger than that is paid for on every read
    // of a task that never displays it.
    output: z.string().max(4_000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    const require = (field: 'sha' | 'command' | 'status', why: string) => {
      if (value[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: why })
      }
    }
    if (value.event === 'git_commit') require('sha', 'a git_commit must name the commit it records')
    if (value.event === 'git_push') require('sha', 'a git_push must name the commit it pushed')
    if (value.event === 'run_result') {
      require('command', 'a run_result must name the command that ran')
      require('status', 'a run_result must say whether it passed, failed or was skipped')
    }
  })

/** `CAI-42` — the identifier agents actually use in prose. */
export const taskRefSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, 'expected a task ref like CAI-42')

export const parseTaskRef = (ref: string): { key: string; number: number } => {
  const parsed = taskRefSchema.parse(ref)
  const idx = parsed.lastIndexOf('-')
  return { key: parsed.slice(0, idx), number: Number(parsed.slice(idx + 1)) }
}
