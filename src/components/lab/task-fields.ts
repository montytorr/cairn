import type { Handoff, TaskLabFields } from './types'

/**
 * A task's Lab-shaped fields, read off whatever the loader returned.
 *
 * `subject` is deliberately left `undefined` when absent: the server omits it
 * while the Lab is off (and sends `null` when on and unlinked), so absent
 * means "draw no Subject row" and null means "draw the row, empty".
 * `handoff` is always present on a task, or null; it is not a Lab feature.
 */
export const taskLabFields = (task: unknown): TaskLabFields => {
  const t = (task ?? {}) as { subject?: TaskLabFields['subject']; handoff?: Handoff | null }
  return {
    ...(t.subject !== undefined ? { subject: t.subject } : {}),
    handoff: t.handoff ?? null,
  }
}
