'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { X } from 'lucide-react'

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

const Row = ({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div
      role="status"
      className="border-danger/40 bg-surface pointer-events-auto flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-lg border px-3 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
    >
      <span className="bg-danger mt-[5px] size-[6px] shrink-0 rounded-full" aria-hidden />
      <p className="text-fg min-w-0 flex-1 text-[12.5px] leading-relaxed break-words">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="text-fg-subtle hover:text-fg -mr-1 shrink-0 transition-colors"
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
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <Row key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </NotifyContext.Provider>
  )
}
