'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useLiveStatus } from '@/components/live-status'
import { cn } from '@/lib/utils'

/** Backoff between our own reconnection attempts, capped. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * What to do when the stream errors, given how the browser has left it.
 *
 * Pure and exported because this one decision was the bug, and getting it
 * wrong is silent: the page keeps rendering, simply never updating again.
 *
 * `closed` is the browser declaring the stream dead for good. It does that for
 * any response that is not 200 `text/event-stream` — a 502 while a deploy
 * swaps the container, a 401 once a session expires — and it will never retry
 * on its own. Anything else is a drop it is already handling, including the
 * ten-minute close the server performs by design.
 */
export const onStreamError = (
  closed: boolean,
  attempt: number,
): { state: 'offline' | 'reconnecting'; retryInMs?: number } =>
  closed
    ? { state: 'offline', retryInMs: RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] }
    : { state: 'reconnecting' }

/**
 * Reflects changes made by an agent while a human is looking at the page.
 *
 * The stream only reports THAT something changed; this then asks the server
 * for the new state through the normal render path. It deliberately does not
 * patch the DOM from the event: applying diffs client-side would be a second,
 * partial implementation of every view.
 *
 * It also reports its connection state to `LiveStatusProvider`, which is what
 * the indicator in the corner shows. Reporting is best-effort: with no
 * provider mounted this still refreshes exactly as before.
 */
export const LiveUpdates = ({ projectKey }: { projectKey?: string }) => {
  const router = useRouter()
  const [stale, setStale] = useState(false)
  const status = useLiveStatus()
  const report = status?.report

  useEffect(() => {
    const url = projectKey
      ? `/api/v1/events?project=${encodeURIComponent(projectKey)}`
      : '/api/v1/events'

    let source: EventSource | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let stopped = false

    /**
     * EventSource retries a dropped connection on its own, but NOT a response
     * it considers fatal — anything that is not 200 with a `text/event-stream`
     * body sets `readyState = CLOSED` and it never tries again. A deploy
     * produces exactly that: the container goes, the reconnect reaches the
     * proxy with no healthy backend, and the 502 is terminal. The page then
     * looked live-updating and silently was not, until someone reloaded.
     *
     * So the retry is ours. `open` is the only thing that resets the backoff,
     * because a connection that fails immediately after opening is still a
     * failing connection.
     */
    const connect = () => {
      if (stopped) return
      source?.close()
      source = new EventSource(url)
      report?.({ state: attempt === 0 ? 'connecting' : 'offline' })

      // `ready` is sent once the server has its first fingerprint, which is a
      // truer "connected" than `open`: `open` fires when the socket is up, not
      // when the stream can actually answer.
      source.addEventListener('ready', () => {
        attempt = 0
        report?.({ state: 'live' })
      })

      source.onerror = () => {
        if (stopped) return
        const next = onStreamError(source?.readyState === EventSource.CLOSED, attempt)
        report?.({ state: next.state })
        if (next.retryInMs === undefined) return
        attempt += 1
        clearTimeout(retry)
        retry = setTimeout(connect, next.retryInMs)
      }

      source.addEventListener('changed', () => {
        report?.({ state: 'updating', changedAt: new Date().toISOString() })

        // Never refresh while the user is typing — a rerender mid-sentence
        // would be worse than being slightly out of date. Offer instead.
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.isContentEditable)

        if (typing) setStale(true)
        else router.refresh()

        // The refresh is a server round trip with no completion callback here,
        // so settle back to `live` on the next tick rather than claiming to
        // know when it landed. This is a liveness signal, not a progress bar.
        clearTimeout(settle)
        settle = setTimeout(() => report?.({ state: 'live' }), 600)
      })
    }

    /**
     * Waiting out a backoff the reader is sitting through is the one case
     * where we know more than the timer does: the network just returned, or
     * they just came back to the tab. Try again now.
     */
    const retryNow = () => {
      if (stopped || source?.readyState !== EventSource.CLOSED) return
      clearTimeout(retry)
      connect()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') retryNow()
    }

    connect()
    window.addEventListener('online', retryNow)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      clearTimeout(settle)
      clearTimeout(retry)
      window.removeEventListener('online', retryNow)
      document.removeEventListener('visibilitychange', onVisible)
      source?.close()
      // The page that owned this stream is going away; a stale badge would
      // outlive it and claim a connection that no longer exists.
      report?.({ state: 'idle' })
    }
  }, [router, projectKey, report])

  if (!stale) return null

  return (
    <button
      type="button"
      onClick={() => {
        setStale(false)
        router.refresh()
      }}
      className={cn(
        'bg-surface text-fg raised-lg enter-pop fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border py-1.5 pr-3 pl-2.5 text-meta font-medium',
        'border-[color:color-mix(in_oklab,var(--accent)_40%,var(--border))] hover:bg-surface-raised',
        'transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]',
      )}
      style={{ '--origin': 'bottom' } as React.CSSProperties}
    >
      <RefreshCw size={12} className="text-accent" aria-hidden />
      Updated elsewhere — refresh
    </button>
  )
}
