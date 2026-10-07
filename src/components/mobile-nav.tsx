'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { AppSidebar } from '@/components/app-sidebar'
import { Button } from '@/components/ui/control'

/**
 * The whole of navigation on a narrow screen. Until this existed the sidebar
 * was simply `hidden md:flex`, which left a phone with no way to reach any
 * project at all.
 */
export const MobileNav = ({
  email,
  role,
  projects,
}: {
  email: string
  role: 'admin' | 'member'
  projects: { key: string; title: string }[]
}) => {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Escape closes it, and the body must not scroll behind an open drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <>
      <Button
        icon
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="md:hidden"
      >
        <Menu size={16} aria-hidden />
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="scrim absolute inset-0"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <aside
            className="app-sidebar enter-sheet relative flex w-[16.875rem] max-w-[82vw] flex-col"
            /* Keyed on the path so a navigation rebuilds it collapsed, rather
               than leaving a filter box half-typed from the last visit. */
            key={pathname}
          >
            <AppSidebar
              email={email}
              role={role}
              projects={projects}
              onNavigate={() => setOpen(false)}
              trailing={
                <Button
                  icon
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                >
                  <X size={14} aria-hidden />
                </Button>
              }
            />
          </aside>
        </div>
      )}
    </>
  )
}
