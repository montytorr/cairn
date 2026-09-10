'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronsUpDown, Keyboard, LogOut, Settings as SettingsIcon } from 'lucide-react'
import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Avatar } from '@/components/icons'
import { Spinner } from '@/components/spinner'
import { useSupabaseConfig } from '@/components/supabase-provider'

/**
 * The sidebar footer.
 *
 * Was a truncated email, a text "Settings" link and a bare "Sign out" that
 * wrapped to two lines in 220px — and once sign out became an icon it was a
 * labelled link beside an unlabelled glyph, which reads worse than either.
 * One row that opens a menu instead: the identity is the affordance, and
 * everything that acts on the account lives behind it.
 */
export const UserMenu = ({ email, onNavigate }: { email: string; onNavigate?: () => void }) => {
  const router = useRouter()
  const { url, anonKey } = useSupabaseConfig()
  const [open, setOpen] = useState(false)
  const [leaving, startLeaving] = useTransition()
  const [pending, setPending] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const busy = pending || leaving

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const signOut = async () => {
    if (busy) return
    setPending(true)
    try {
      await createBrowserClient(url, anonKey).auth.signOut()
      // Stays busy through the navigation, or the row flashes back to idle
      // while the login page is still loading.
      startLeaving(() => {
        router.replace('/login')
        router.refresh()
      })
    } catch {
      // The local session is gone regardless; leaving someone on a page they
      // can no longer use would be worse than a silent failure.
      router.replace('/login')
    } finally {
      setPending(false)
    }
  }

  const item =
    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg'

  return (
    <div ref={wrap} className="border-border relative border-t p-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="hover:bg-surface-hover flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors"
      >
        <Avatar name={email} size={18} />
        <span className="text-fg-muted min-w-0 flex-1 truncate text-left text-[12px]" title={email}>
          {email}
        </span>
        {busy ? (
          <Spinner size={12} />
        ) : (
          <ChevronsUpDown size={12} className="text-fg-subtle shrink-0" aria-hidden />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="border-border bg-surface absolute bottom-[calc(100%-2px)] left-1.5 right-1.5 z-50 overflow-hidden rounded-md border py-1 shadow-xl"
        >
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onNavigate?.()
            }}
            className={item}
          >
            <SettingsIcon size={13} aria-hidden />
            Settings and API keys
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              // The `?` handler lives on the shortcuts overlay itself.
              document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))
            }}
            className={item}
          >
            <Keyboard size={13} aria-hidden />
            Keyboard shortcuts
          </button>

          <div className="border-border my-1 border-t" />

          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void signOut()}
            className={`${item} text-danger hover:bg-danger-subtle hover:text-danger disabled:opacity-60`}
          >
            {busy ? <Spinner size={13} /> : <LogOut size={13} aria-hidden />}
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}
