'use client'

import { useEffect } from 'react'

/**
 * Mounts the Scalar reference explicitly.
 *
 * Older builds self-mounted from a `<div data-url="…">`; the current one
 * exposes exactly one function and does nothing until it is called. This page
 * therefore rendered an empty container for however long it took anyone to
 * look — the script loaded successfully, found nothing to do, and reported no
 * error. Hence both the explicit call and the pinned version.
 */
type ScalarGlobal = {
  Scalar?: { createApiReference: (selector: string, options: { url: string }) => void }
}

const SRC =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0/dist/browser/standalone.js'

export const ApiReference = ({ specUrl }: { specUrl: string }) => {
  useEffect(() => {
    const mount = () => {
      const scalar = (window as unknown as ScalarGlobal).Scalar
      if (!scalar) return false
      scalar.createApiReference('#scalar', { url: specUrl })
      return true
    }

    if (mount()) return

    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.onload = () => void mount()
    document.body.appendChild(script)
  }, [specUrl])

  return <div id="scalar" />
}
