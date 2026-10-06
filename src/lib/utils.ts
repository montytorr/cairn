import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * The type scale's names (globals.css) are font sizes. Unregistered, the merge
 * reads `text-meta` as a colour and drops it whenever a colour such as
 * `text-fg-muted` follows, which silently put every such chip back at body size.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['ui', 'meta', 'label'] }] } },
})

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** `CAI-42` from a project key and a per-project task number. */
export const taskRef = (projectKey: string, number: number) => `${projectKey}-${number}`

/**
 * The inverse: a task ref scraped off a session or note into the URL that
 * opens it. `null` for anything that is not shaped like a ref at all, so a
 * caller can drop it rather than link to a 404.
 */
export const taskRefHref = (ref: string): string | null => {
  const match = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(ref)
  if (!match) return null
  return `/projects/${match[1]}/tasks/${match[2]}`
}

/**
 * A claim is stale when its holder has stopped beating. Computed on read
 * rather than reaped by a background job — that is what lets the claim
 * mutex steal an abandoned lease in a single conditional UPDATE.
 */
export const CLAIM_LEASE_SECONDS = 900

export const isClaimStale = (heartbeatAt: string | null | undefined): boolean => {
  if (!heartbeatAt) return false
  return Date.now() - new Date(heartbeatAt).getTime() > CLAIM_LEASE_SECONDS * 1000
}

/**
 * Alphabetical the way a person reads it.
 *
 * Postgres sorts titles case-sensitively under this collation, so every
 * lowercase name — `invoice-api`, `n8n` — sank below every capitalised one,
 * and `SL Gateway` came before `Sales Portal` because `L` precedes `a` in
 * ASCII. Ordering in SQL and calling it alphabetical was the
 * mistake; `localeCompare` is what the word means.
 *
 * Done in JS rather than as `order by lower(title)` because the adapter takes a
 * column name, not an expression, and a project list is a few dozen rows.
 */
export const byTitle = <T extends { title?: string | null; key?: string | null }>(a: T, b: T) =>
  (a.title ?? a.key ?? '').localeCompare(b.title ?? b.key ?? '', undefined, {
    sensitivity: 'base',
    numeric: true,
  })
