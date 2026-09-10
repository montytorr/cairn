'use client'

import { useEffect } from 'react'
import Link from 'next/link'

/**
 * There was no error boundary anywhere, so a single bad render showed Next's
 * raw stack page. This keeps the reader inside the app and — the part that
 * matters — surfaces the digest, which is the only handle on a minified
 * production error.
 */
const AppError = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => {
  useEffect(() => {
    console.error('[cairn] render failed', error)
  }, [error])

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-fg text-[15px] font-medium">That page did not render.</h1>
        <p className="text-fg-muted max-w-[46ch] text-[13px] leading-relaxed">
          Nothing was lost — this is a display failure, not a write. Retrying usually works.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="bg-accent text-accent-fg h-[30px] rounded-md px-3.5 text-[13px] font-medium"
        >
          Try again
        </button>
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hover:bg-surface-hover h-[30px] rounded-md px-3.5 text-[13px] leading-[30px] transition-colors"
        >
          Back to all tasks
        </Link>
      </div>

      {error.digest && (
        <code className="text-fg-subtle text-[11px]">
          digest {error.digest}
        </code>
      )}
    </div>
  )
}

export default AppError
