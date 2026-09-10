'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { LogOut } from 'lucide-react'
import { useSupabaseConfig } from '@/components/supabase-provider'
import { Spinner } from '@/components/spinner'

/**
 * Was bare text with no affordance, no busy state and no error handling — a
 * click did nothing visible for as long as the sign-out call and the redirect
 * took, which on a loaded host is over a second.
 */
export const SignOut = () => {
  const router = useRouter()
  const { url, anonKey } = useSupabaseConfig()
  const [pending, setPending] = useState(false)
  const [leaving, startLeaving] = useTransition()
  const [failed, setFailed] = useState(false)
  const busy = pending || leaving

  const signOut = async () => {
    if (busy) return
    setPending(true)
    setFailed(false)
    try {
      await createBrowserClient(url, anonKey).auth.signOut()
      // Stays busy through the navigation: clearing it here would flash the
      // button back to idle while the login page was still loading.
      startLeaving(() => {
        router.replace('/login')
        router.refresh()
      })
    } catch {
      // The local session is gone either way, so go anyway rather than
      // trapping someone on a page they can no longer use.
      setFailed(true)
      router.replace('/login')
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      aria-label="Sign out"
      title={failed ? 'Signed out locally; the server call failed' : 'Sign out'}
      className="text-fg-subtle hover:text-fg hover:bg-surface-hover flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors disabled:opacity-60"
    >
      {busy ? <Spinner size={12} /> : <LogOut size={12} aria-hidden />}
      {/* Label only where there is room: at 220px it wrapped to "Sign / out",
          which looked broken. The button is still named for a screen reader. */}
      <span className="sr-only">{busy ? 'Signing out…' : 'Sign out'}</span>
    </button>
  )
}
