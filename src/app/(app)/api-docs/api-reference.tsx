'use client'

import { useEffect, useRef } from 'react'

/**
 * Mounts the Scalar reference, and — the part that matters — unmounts it.
 *
 * Scalar is a full application, not a widget: it binds its own ⌘K palette to
 * the document. Cairn binds ⌘K too, so leaving this page without tearing
 * Scalar down meant the API endpoint search kept opening over every other page
 * in the app. Nothing looked broken on /api-docs itself; the damage was
 * everywhere else, which is the usual shape of a leak in a single-page app.
 *
 * `createApiReference` returns a handle with `destroy()`. The effect calls it
 * on unmount, so the listener leaves with the page that wanted it.
 *
 * Two further notes. The version is pinned because this page rendered nothing
 * at all after a CDN bump — older builds self-mounted from a `<div data-url>`,
 * the current one does nothing until called, and the script loaded
 * successfully either way. And the script tag is left in place deliberately: a
 * loaded library binds nothing on its own, and removing it would only force a
 * re-download on the next visit.
 */
type ScalarApp = { destroy: () => void }
type ScalarGlobal = {
  Scalar?: {
    createApiReference: (selector: string, options: { url: string }) => ScalarApp
  }
}

const SRC =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0/dist/browser/standalone.js'

export const ApiReference = ({ specUrl }: { specUrl: string }) => {
  const app = useRef<ScalarApp | null>(null)

  useEffect(() => {
    let cancelled = false

    const mount = () => {
      const scalar = (window as unknown as ScalarGlobal).Scalar
      if (!scalar || cancelled) return false
      app.current = scalar.createApiReference('#scalar', { url: specUrl })
      return true
    }

    if (!mount()) {
      const script = document.createElement('script')
      script.src = SRC
      script.async = true
      script.onload = () => void mount()
      document.body.appendChild(script)
    }

    return () => {
      cancelled = true
      try {
        app.current?.destroy()
      } catch {
        // A teardown that throws must not take the navigation with it.
      }
      app.current = null
    }
  }, [specUrl])

  return <div id="scalar" />
}
