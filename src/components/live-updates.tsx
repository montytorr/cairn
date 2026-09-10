'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Reflects changes made by an agent while a human is looking at the page.
 *
 * The stream only reports THAT something changed; this then asks the server
 * for the new state through the normal render path. It deliberately does not
 * patch the DOM from the event: applying diffs client-side would be a second,
 * partial implementation of every view.
 */
export const LiveUpdates = ({ projectKey }: { projectKey?: string }) => {
  const router = useRouter()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const url = projectKey
      ? `/api/v1/events?project=${encodeURIComponent(projectKey)}`
      : '/api/v1/events'
    const source = new EventSource(url)

    source.addEventListener('changed', () => {
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
    })

    return () => source.close()
  }, [router, projectKey])

  if (!stale) return null

  return (
    <button
      type="button"
      onClick={() => {
        setStale(false)
        router.refresh()
      }}
      className="bg-accent text-accent-fg pop fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full px-3 py-1.5 text-[12px] font-medium shadow-lg"
    >
      Updated elsewhere — refresh
    </button>
  )
}
