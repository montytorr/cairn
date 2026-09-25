'use client'

import { useEffect, useState } from 'react'
import { Columns3, List } from 'lucide-react'
import { BoardView } from './board-view'
import { ListView } from './list-view'
import { cn } from '@/lib/utils'
import type { TaskListItem } from '@/lib/data'
import { viewCookieName, type ProjectView } from '@/lib/project-view'

const LEGACY_STORAGE_KEY = (projectKey: string) => `cairn:view:${projectKey}`

const rememberView = (projectKey: string, view: ProjectView) => {
  document.cookie = `${viewCookieName(projectKey)}=${view}; path=/; max-age=31536000; samesite=lax`
}

/**
 * Board or list, remembered per project in a cookie — a per-viewer
 * convenience, not shared state. A cookie rather than localStorage because
 * the server has to render the same view the client hydrates: reading
 * localStorage in the state initializer gave the server `list` every time,
 * so a board user got the list, a hydration mismatch, then the board.
 */
export const ViewSwitch = ({
  tasks,
  recentlyClosed,
  projectKey,
  initialView,
}: {
  tasks: TaskListItem[]
  recentlyClosed: TaskListItem[]
  projectKey: string
  /** From the view cookie; null when this viewer never picked one here. */
  initialView: ProjectView | null
}) => {
  const [view, setView] = useState<ProjectView>(initialView ?? 'list')

  // One-time carry-over for a choice saved before the cookie existed.
  useEffect(() => {
    if (initialView) return
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY(projectKey))
      if (legacy !== 'board') return
      setView('board')
      rememberView(projectKey, 'board')
      localStorage.removeItem(LEGACY_STORAGE_KEY(projectKey))
    } catch {
      // blocked storage; nothing to carry over
    }
  }, [initialView, projectKey])

  const pick = (next: ProjectView) => {
    setView(next)
    rememberView(projectKey, next)
  }

  const button = (value: 'board' | 'list', Icon: typeof List, label: string) => (
    <button
      type="button"
      onClick={() => pick(value)}
      aria-pressed={view === value}
      title={label}
      className={cn(
        'grid size-[1.375rem] place-items-center rounded transition-all duration-100',
        view === value
          ? 'bg-surface text-fg raised-sm'
          : 'text-fg-subtle hover:text-fg',
      )}
    >
      <Icon size={13} />
    </button>
  )

  // Rendered inside the list's own toolbar rather than in a band of its own:
  // two rows of chrome above one list was 88px spent before a single task.
  const toggle = (
    <span className="bg-surface-raised flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
      {button('list', List, 'List view')}
      {button('board', Columns3, 'Board view')}
    </span>
  )

  // The board fills the height and scrolls per column; the list is a
  // document and scrolls as one.
  return view === 'board' ? (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-3 py-2">{toggle}</div>
      <div className="min-h-0 flex-1">
        <BoardView tasks={tasks} projectKey={projectKey} />
      </div>
    </div>
  ) : (
    <div className="h-full overflow-y-auto">
      <ListView
        tasks={tasks}
        recentlyClosed={recentlyClosed}
        projectKey={projectKey}
        toolbarExtra={toggle}
      />
    </div>
  )
}
