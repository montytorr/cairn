import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

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

