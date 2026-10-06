'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CircleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Where a failed write goes when the control that made it has nowhere to put
 * an error.
 *
 * A dragged card, a status badge, a sign-out — none of them own a line of the
 * page to write on, so before this the refusal had nowhere to go and was
 * simply dropped. Components that already have an error slot keep it; this is
 * for the ones that do not.
 *
 * Deliberately not a full toast library: no stacking animation, no promise
 * API, no variants. One list, dismissible, and it does not disappear so fast
 * that a message can be missed.
 */

type Toast = { id: number; message: string }

const NotifyContext = createContext<(message: string) => void>(() => {})

/** Shows `message` in the corner. Safe to call from anywhere under the host. */
export const useNotify = () => useContext(NotifyContext)

const DISMISS_AFTER_MS = 9000

const LEAVE_MS = 200

const Row = ({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) => {
  const ref = useRef<HTMLDivElement>(null)
  const leaving = useRef(false)

  // Slides out before it goes, rather than blinking away. Script-driven, so it
  // asks about reduced motion itself: the global CSS rule cannot reach it.
  const leave = useCallback(() => {
    if (leaving.current) return
    leaving.current = true
    const el = ref.current
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!el || still || typeof el.animate !== 'function') {
      onDismiss(toast.id)
      return
    }
    const exit = el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateX(12px) scale(0.98)' },
      ],
      { duration: LEAVE_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
    )
    exit.onfinish = () => onDismiss(toast.id)
    exit.oncancel = () => onDismiss(toast.id)
  }, [toast.id, onDismiss])

  useEffect(() => {
    const timer = setTimeout(leave, DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [leave])

  return (
    <div
      ref={ref}
      role="status"
      className={cn(
        'border-border bg-surface raised-lg enter-rise pointer-events-auto relative flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 overflow-hidden rounded-lg border py-2 pr-3 pl-3.5',
        // The tone, as a thin edge of its colour down the left.
        'before:bg-danger before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-full',
      )}
    >
      <CircleAlert size={14} className="text-danger mt-[0.1875rem] shrink-0" aria-hidden />
      <p className="text-fg min-w-0 flex-1 text-ui leading-relaxed break-words">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={leave}
        aria-label="Dismiss"
        className="text-fg-subtle hover:text-fg hover:bg-surface-hover -mr-1 grid size-5 shrink-0 place-items-center rounded transition-colors duration-[var(--dur-1)]"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export const ToastHost = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const notify = useCallback((message: string) => {
    setToasts((current) => {
      // The same failure repeated — a drag retried three times — is one
      // message, not a wall of identical ones.
      if (current.some((t) => t.message === message)) return current
      return [...current, { id: Date.now() + current.length, message }]
    })
  }, [])

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {/* Above the resolution dialog, which sits at z-50: a write refused from
          inside a modal has to be readable without closing the modal first. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end sm:px-0"
      >
        {toasts.map((toast) => (
          <Row key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </NotifyContext.Provider>
  )
}
