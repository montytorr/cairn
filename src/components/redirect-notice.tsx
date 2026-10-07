'use client'

import { useEffect, useState } from 'react'
import { ArrowRightLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/control'

/**
 * Says where an old address brought you, once.
 *
 * `/tasks/AC-113` used to land on HOL-113 without a word, which is the moment
 * a reader holding AC-113 most needs telling they found the same task. The
 * page renders this from a `?from=` marker on the redirect; the marker is then
 * dropped from the address bar, so a copied link or a reload is the clean URL.
 *
 * The message is kept in state rather than read from props each render: the
 * live stream re-renders the page through `router.refresh()`, and once the
 * marker is gone the server has nothing to say — the notice should stay until
 * dismissed, not vanish when an agent writes a note.
 */
export const RedirectNotice = ({
  message,
  className,
}: {
  message: string | null
  className?: string
}) => {
  const [shown, setShown] = useState(message)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('from')) return
    url.searchParams.delete('from')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  if (!shown) return null

  return (
    <div
      role="status"
      className={cn(
        'text-fg-muted enter-rise flex items-start gap-2 rounded-lg border py-2 pr-1.5 pl-3 text-ui leading-relaxed',
        'border-[color:color-mix(in_oklab,var(--accent)_30%,transparent)]',
        'bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]',
        className ?? 'mb-5',
      )}
    >
      <ArrowRightLeft size={13} className="text-accent mt-[3px] shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{shown}</p>
      <Button icon size="sm" variant="ghost" onClick={() => setShown(null)} className="-my-1.5 -mr-1.5">
        <X size={14} aria-hidden />
        <span className="sr-only">Dismiss</span>
      </Button>
    </div>
  )
}
