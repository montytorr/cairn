import { shortDateWithYear } from '@/lib/dates'

/**
 * What the screen says about a project key that changed.
 *
 * Resolution alone was never the problem — CAIRN-125 made AC-113 find HOL-113.
 * The problem is that it found it silently, so someone holding AC-113 from a
 * commit message landed on a page reading HOL-113 and could not tell whether
 * they had the right task. Everything here turns the rename record into a
 * sentence, and is pure so the rules can be tested without a database.
 */

/** The rule the API enforces on a project key. Kept here so the form can say it first. */
export const PROJECT_KEY_RULE = /^[A-Z][A-Z0-9]{1,9}$/

export type RetiredKey = { key: string; retired_at: string }

/** One key change: `from` stopped being the key at `at`, and `to` took over. */
export type Rename = { from: string; to: string; at: string }

const time = (iso: string) => Date.parse(iso)

/**
 * A project's key changes, oldest first. A key retired later is what the one
 * before it became, so AC → X → HOL is read as AC→X, then X→HOL.
 */
export const renamesOf = (retired: RetiredKey[], current: string): Rename[] => {
  const sorted = [...retired].sort((a, b) => time(a.retired_at) - time(b.retired_at))
  return sorted.map((row, i) => ({
    from: row.key,
    to: sorted[i + 1]?.key ?? current,
    at: row.retired_at,
  }))
}

/** `project renamed AC → HOL on 22 Sept 2026` */
export const renameLine = (rename: Rename) =>
  `project renamed ${rename.from} → ${rename.to} on ${shortDateWithYear(rename.at)}`

/**
 * The refs this task was really known by.
 *
 * Only keys retired AFTER the task was filed. HOL-114 was created once AC was
 * already gone, and a label claiming "was AC-114" invents a ref nobody could
 * ever have written down.
 */
export const formerRefsOf = (
  renames: Rename[],
  task: { number: number; created_at: string },
): { ref: string; rename: Rename }[] =>
  renames
    .filter((rename) => time(task.created_at) < time(rename.at))
    .map((rename) => ({ ref: `${rename.from}-${task.number}`, rename }))

const REF = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/

/**
 * The line shown after `/projects/AC/tasks/113` redirected here, or null.
 *
 * `from` comes off the query string, so it is only believed when it names a
 * key this project actually retired and this task's number: anything else is
 * a hand-edited URL, and the page would be asserting a rename that never
 * happened.
 */
export const taskRedirectNotice = (
  from: string | undefined,
  renames: Rename[],
  task: { number: number; created_at: string; ref: string },
): string | null => {
  const match = REF.exec((from ?? '').toUpperCase())
  if (!match || Number(match[2]) !== task.number) return null
  const rename = renames.find((r) => r.from === match[1])
  if (!rename) return null

  const ref = match[0]
  const current = renames.at(-1)?.to ?? rename.to
  const when = shortDateWithYear(rename.at)
  const then = rename.to !== current ? `, and later ${current}` : ''

  if (time(task.created_at) >= time(rename.at)) {
    return (
      `${ref} never existed — project ${rename.from} was renamed ${rename.to} on ${when}${then}, ` +
      `before this task was filed. This is ${task.ref}, the task with the same number.`
    )
  }
  return `${ref} is now ${task.ref} — project ${rename.from} was renamed ${rename.to} on ${when}${then}.`
}

/**
 * The line shown after a ref the task was filed under before moving to another
 * project redirected here, or null. Believed only when `from` is one of the
 * task's own former refs, like `taskRedirectNotice`.
 */
export const taskMovedNotice = (
  from: string | undefined,
  moves: { ref: string; at: string }[],
  task: { ref: string },
): string | null => {
  const ref = (from ?? '').toUpperCase()
  const move = moves.find((m) => m.ref === ref)
  if (!move) return null
  return `${ref} is now ${task.ref} — the task moved to another project on ${shortDateWithYear(move.at)}.`
}

/** The line shown after `/projects/AC` redirected here, or null. */
export const projectRedirectNotice = (from: string | undefined, renames: Rename[]): string | null => {
  const key = (from ?? '').toUpperCase()
  const rename = renames.find((r) => r.from === key)
  if (!rename) return null
  const current = renames.at(-1)?.to ?? rename.to
  return (
    `${key} is now ${current} — the project was renamed on ${shortDateWithYear(rename.at)}. ` +
    `Old ${key}-n refs still lead to their tasks.`
  )
}

/**
 * Why a proposed key cannot be used, or null when it can.
 *
 * The server is the authority — it refuses the same things — but a rename is
 * the one edit whose refusal arrives after the reader has already decided, so
 * the reasons are given while typing instead.
 */
export const keyChangeProblem = (
  draft: string,
  {
    projectId,
    current,
    liveKeys,
    retired,
  }: {
    projectId: string
    current: string
    liveKeys: string[]
    retired: { key: string; project_id: string; current: string }[]
  },
): string | null => {
  const key = draft.trim().toUpperCase()
  if (!key) return 'Type the new key.'
  if (!PROJECT_KEY_RULE.test(key)) {
    return 'Two to ten letters or digits, starting with a letter.'
  }
  if (key === current) return `${key} is already this project's key.`
  if (liveKeys.includes(key)) return `${key} is already the key of another project.`
  const owner = retired.find((row) => row.key === key)
  if (owner && owner.project_id !== projectId) {
    return (
      `${key} used to be ${owner.current}'s key and can never be reused — ` +
      `every ${key}-n ref still leads to ${owner.current}.`
    )
  }
  return null
}
