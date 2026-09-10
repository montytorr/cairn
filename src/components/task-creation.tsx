'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { CreateTask } from './create-task'

type Ctx = { open: () => void }
const CreateContext = createContext<Ctx>({ open: () => undefined })

export const useCreateTask = () => useContext(CreateContext)

/**
 * Holds the create dialog once, at the root, so any button can open it and
 * `c` works from anywhere. Mounting it per-view would mean several copies of
 * the same state and a shortcut that only fires on some pages.
 */
export const TaskCreationProvider = ({
  projects,
  children,
}: {
  projects: { key: string; title: string }[]
  children: React.ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(false)
  // Bumped on each open so <CreateTask> remounts with fresh state, instead of
  // an effect resetting half a dozen fields.
  const [instance, setInstance] = useState(0)
  const pathname = usePathname()

  // Creating from inside a project should default to that project.
  const projectFromPath = useMemo(() => {
    const match = /^\/projects\/([^/]+)/.exec(pathname ?? '')
    return match?.[1]?.toUpperCase()
  }, [pathname])

  const open = useCallback(() => {
    setInstance((n) => n + 1)
    setIsOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return
      }
      if (e.key === 'c') {
        e.preventDefault()
        setInstance((n) => n + 1)
        setIsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(() => ({ open }), [open])

  return (
    <CreateContext.Provider value={value}>
      {children}
      <CreateTask
        key={instance}
        projects={projects}
        defaultProject={projectFromPath}
        open={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </CreateContext.Provider>
  )
}

/** The button that appears in list headers. */
export const NewTaskButton = () => {
  const { open } = useCreateTask()
  return (
    <button
      type="button"
      onClick={open}
      title="New task — c"
      className="border-border text-fg-muted hover:bg-surface-hover hover:text-fg flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors"
    >
      New task
      <kbd className="kbd">c</kbd>
    </button>
  )
}
