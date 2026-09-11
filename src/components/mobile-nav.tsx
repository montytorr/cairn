'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { AppSidebar } from '@/components/app-sidebar'

/**
 * The whole of navigation on a narrow screen. Until this existed the sidebar
 * was simply `hidden md:flex`, which left a phone with no way to reach any
 * project at all.
 */
export const MobileNav = ({
  email,
  projects,
}: {
  email: string
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="text-fg-muted hover:text-fg hover:bg-surface-hover grid size-[30px] shrink-0 place-items-center rounded-md transition-colors md:hidden"
      >
        <Menu size={16} aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0 bg-black/55"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <aside
            className="bg-bg-elevated border-border relative flex w-[270px] max-w-[82vw] flex-col border-r shadow-2xl"
            /* Keyed on the path so a navigation rebuilds it collapsed, rather
               than leaving a filter box half-typed from the last visit. */
            key={pathname}
          >
            <AppSidebar
              email={email}
              projects={projects}
              onNavigate={() => setOpen(false)}
              trailing={
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="text-fg-subtle hover:text-fg hover:bg-surface-raised grid size-6 place-items-center rounded transition-colors"
                >
                  <X size={14} aria-hidden />
                </button>
              }
            />
          </aside>
        </div>
      )}
    </>
  )
}
