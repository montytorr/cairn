import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** `CAI-42` from a project key and a per-project task number. */
export const taskRef = (projectKey: string, number: number) => `${projectKey}-${number}`

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

