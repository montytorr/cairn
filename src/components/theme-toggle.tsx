'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/control'

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
    <Button
      icon
      size="sm"
      variant="ghost"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className="group"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <Sun
        size={14}
        className="hidden transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)] group-hover:rotate-45 dark:block"
        aria-hidden
      />
      <Moon
        size={14}
        className="block transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)] group-hover:-rotate-12 dark:hidden"
        aria-hidden
      />
    </Button>
  )
}
