'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { mutate } from '@/lib/api/mutate'

/**
 * A badge you can change in place.
 *
 * The control is a native `<select>` laid transparently over the badge. It
 * looks like nothing and behaves like everything: keyboard accessible without
 * any roving-tabindex code, and on a phone it opens the platform picker, which
 * beats any popover that could be written here.
 */
export const QuickSelect = <T extends string>({
  value,
  options,
  labels,
  children,
  onChange,
  title,
  className,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  children: React.ReactNode
  onChange: (next: T) => void
  title: string
  className?: string
}) => (
  <span
    className={cn(
      'relative z-10 -mx-1 inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded px-1',
      'transition-[background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease)]',
      // A wash of the foreground rather than the hover fill: it has to show
      // on a row that is itself already hovered.
      'hover:bg-[color-mix(in_oklab,var(--fg)_7%,transparent)]',
      // The select is invisible, so its focus has to be drawn on the badge.
      'has-[select:focus-visible]:ring-ring/50 has-[select:focus-visible]:ring-2',
      className,
    )}
  >
    {children}
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      onClick={(e) => e.stopPropagation()}
      aria-label={title}
      title={title}
      className="select-overlay"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  </span>
)

/**
 * PATCHes one task and refreshes.
 *
 * Optimistic, and stamped with the row's `updated_at` so the overlay retires
 * itself when fresh data arrives instead of being cleared by an effect — the
 * same trick the task sidebar uses.
 */
export const useQuickPatch = (taskRef: string, updatedAt: string) => {
  const router = useRouter()
  const [optimistic, setOptimistic] = useState<{
    at: string
    values: Record<string, unknown>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const overlay = optimistic && optimistic.at === updatedAt ? optimistic.values : null

  const patch = async (values: Record<string, unknown>) => {
    setOptimistic({ at: updatedAt, values })
    setError(null)
    // There was no try/catch here, so a dropped connection left the overlay
    // in place forever — the row went on showing a value that was never
    // written, with nothing to say so.
    const result = await mutate(`/api/v1/tasks/${taskRef}`, { method: 'PATCH', body: values })
    if (!result.ok) {
      setOptimistic(null)
      setError(result.error)
      return false
    }
    router.refresh()
    return true
  }

  return { patch, overlay, error, clearError: () => setError(null) }
}
