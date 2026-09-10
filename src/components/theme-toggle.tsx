'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

/**
 * No `mounted` flag and no effect.
 *
 * The usual pattern — set a mounted flag in useEffect so the server does not
 * render the wrong icon — calls setState synchronously inside an effect and
 * triggers a cascading render. Both icons are rendered instead, and CSS picks
 * the visible one from the `.dark` class next-themes puts on <html>. That is
 * hydration-safe because the markup does not depend on client-only state.
 */
export const ThemeToggle = () => {
  const { setTheme, resolvedTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className="text-fg-subtle hover:text-fg hover:bg-surface-raised grid size-6 place-items-center rounded transition-colors"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <Sun size={14} className="hidden dark:block" aria-hidden />
      <Moon size={14} className="block dark:hidden" aria-hidden />
    </button>
  )
}
