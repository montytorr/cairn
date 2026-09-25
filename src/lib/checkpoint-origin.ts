/**
 * Telling a checkpoint somebody wrote from one the session-end hook wrote.
 *
 * The automatic ones end with this marker, and have since the first version
 * that wrote them, so the text alone classifies every checkpoint already in
 * the database without a backfill. Client-safe on purpose: the resolution
 * dialog needs the same answer the server does.
 */
export const AUTO_CHECKPOINT_MARKER = '_Recorded automatically when the session ended._'

/** How the "held, but this session worked elsewhere" checkpoint begins. */
export const UNTOUCHED_CHECKPOINT_PREFIX = 'Still held, not progressed'

export const isAutoCheckpoint = (summary: string | null | undefined): boolean =>
  Boolean(summary?.trimEnd().endsWith(AUTO_CHECKPOINT_MARKER))

/**
 * An automatic checkpoint that records nothing but the fact of holding.
 *
 * It is written without anyone looking at the task, so it is not evidence
 * that anyone is working on it — the reaper must not read it as a sign of life.
 */
export const isUntouchedAutoCheckpoint = (summary: string | null | undefined): boolean =>
  isAutoCheckpoint(summary) && Boolean(summary?.startsWith(UNTOUCHED_CHECKPOINT_PREFIX))

/**
 * What the close dialog may offer as a resolution.
 *
 * Only something an agent or a person wrote about this task. The automatic
 * text describes a session, not how the task ended, and offered as the
 * default it gets confirmed: five closed tasks carried "Still held, not
 * progressed…" as their resolution, and three "Next: …".
 */
export const resolutionSuggestion = (checkpoint: string | null | undefined): string | null =>
  checkpoint && !isAutoCheckpoint(checkpoint) ? checkpoint : null
