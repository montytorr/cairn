'use client'

import { useSyncExternalStore } from 'react'
import { isClaimStale } from '@/lib/utils'

/**
 * False on the server and on the first client render, true afterwards.
 *
 * The point is anything whose value depends on the reader's clock or browser:
 * the server cannot know it, so rendering it during hydration guarantees a
 * mismatch. Gate on this and the first render agrees by construction.
 */
const neverChanges = () => () => {}
const onClient = () => true
const onServer = () => false

export const useMounted = () => useSyncExternalStore(neverChanges, onClient, onServer)

/**
 * Staleness for rendering, as opposed to `isClaimStale` for logic.
 *
 * `isClaimStale` reads the clock, and the server's clock is not the reader's:
 * a claim sitting either side of the lease boundary renders differently on
 * each, which React reports as a hydration mismatch. This reports "not stale"
 * until mounted, so the first render always agrees.
 */
export const useRenderedClaimStale = (heartbeatAt: string | null | undefined): boolean => {
  const mounted = useMounted()
  return mounted && isClaimStale(heartbeatAt)
}
