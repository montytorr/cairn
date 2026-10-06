'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/control'

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
    <div className="flex h-dvh flex-col items-center justify-center px-6">
      <EmptyState
        className={error.digest ? 'pb-5' : undefined}
        as="h1"
        title={<span className="text-fg text-[1.125rem]">That page did not render.</span>}
        hint="Nothing was lost — this is a display failure, not a write. Retrying usually works."
        action={
          <>
            <Button variant="primary" onClick={reset} className="px-3.5">
              Try again
            </Button>
            <Link
              href="/"
              className="text-fg-muted hover:text-fg hover:bg-surface-raised inline-flex h-8 items-center rounded-md px-3.5 text-ui font-medium transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]"
            >
              Back to all tasks
            </Link>
          </>
        }
      />

      {error.digest && (
        <code className="text-fg-subtle border-border bg-surface-raised/50 rounded-md border px-2 py-0.5 text-meta">
          digest {error.digest}
        </code>
      )}
    </div>
  )
}

export default AppError
