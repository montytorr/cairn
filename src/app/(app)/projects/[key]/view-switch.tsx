'use client'

import { useEffect, useMemo, useState } from 'react'
import { Columns3, List } from 'lucide-react'
import { BoardView } from './board-view'
import { ListView, PILL_CLASS, useSlidingPill } from './list-view'
import { cn } from '@/lib/utils'
import { AssigneeFilter, useAssigneeFilter } from '@/components/assignee-filter'
import { matchesAssignees } from '@/lib/assignee-filter'
import type { TaskListItem } from '@/lib/data'
import { viewCookieName, type ProjectView } from '@/lib/project-view'

const LEGACY_STORAGE_KEY = (projectKey: string) => `cairn:view:${projectKey}`

// Secure wherever the page itself is served over HTTPS; plain http is only
// ever local development, where a Secure cookie would never be stored.
const rememberView = (projectKey: string, view: ProjectView) => {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${viewCookieName(projectKey)}=${view}; path=/; max-age=31536000; samesite=lax${secure}`
}

/**
 * The two-way switch. It is drawn in the list's toolbar in one view and in a
 * bar of its own in the other, so it remounts on every change; `from` is the
 * view it is leaving, and the pill starts there and slides across.
 */
const ViewToggle = ({
  view,
  from,
  onPick,
}: {
  view: ProjectView
  from: ProjectView | null
  onPick: (next: ProjectView) => void
}) => {
  const { track, pill } = useSlidingPill(view, from)

  const button = (value: ProjectView, Icon: typeof List, label: string) => (
    <button
      type="button"
      data-pill={value}
      onClick={() => onPick(value)}
      aria-pressed={view === value}
      title={label}
      className={cn(
        'relative grid size-[1.375rem] place-items-center rounded',
        'transition-colors duration-[var(--dur-2)] ease-[var(--ease-out)]',
        view === value
          ? 'bg-surface text-fg ring-border ring-1 group-data-[measured]/view:bg-transparent group-data-[measured]/view:ring-0'
          : 'text-fg-subtle hover:text-fg',
      )}
    >
      <Icon size={13} />
    </button>
  )

  return (
    <div className="bg-surface-raised flex shrink-0 items-center rounded-md p-0.5">
      <div ref={track} className="group/view relative flex items-center gap-0.5">
        <span
          ref={pill}
          aria-hidden
          className={cn(PILL_CLASS, 'bg-surface ring-border rounded ring-1')}
        />
        {button('list', List, 'List view')}
        {button('board', Columns3, 'Board view')}
      </div>
    </div>
  )
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
  initialAssignee,
}: {
  tasks: TaskListItem[]
  recentlyClosed: TaskListItem[]
  projectKey: string
  /** From the view cookie; null when this viewer never picked one here. */
  initialView: ProjectView | null
  initialAssignee?: string | null
}) => {
  // One choice for both views: switching to the board should not quietly go
  // back to showing somebody else's work.
  const assignees = useAssigneeFilter(initialAssignee)
  const boardTasks = useMemo(
    () => tasks.filter((t) => matchesAssignees(t, assignees.selected)),
    [tasks, assignees.selected],
  )
  const [view, setView] = useState<ProjectView>(initialView ?? 'list')
  const [from, setFrom] = useState<ProjectView | null>(null)

  // One-time carry-over for a choice saved before the cookie existed.
  useEffect(() => {
    if (initialView) return
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY(projectKey))
      if (legacy !== 'board') return
      // Storage the server cannot read, so this cannot be the initial state
      // without a hydration mismatch. It runs once, for a legacy choice only.
      // (The compiler bailed out of this component before, which is the only
      // reason this line was never flagged.)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView('board')
      rememberView(projectKey, 'board')
      localStorage.removeItem(LEGACY_STORAGE_KEY(projectKey))
    } catch {
      // blocked storage; nothing to carry over
    }
  }, [initialView, projectKey])

  const pick = (next: ProjectView) => {
    if (next !== view) setFrom(view)
    setView(next)
    rememberView(projectKey, next)
  }

  // Rendered inside the list's own toolbar rather than in a band of its own:
  // two rows of chrome above one list was 88px spent before a single task.
  const toggle = <ViewToggle view={view} from={from} onPick={pick} />

  // The board fills the height and scrolls per column; the list is a
  // document and scrolls as one.
  return view === 'board' ? (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        {toggle}
        <span className="bg-border mx-0.5 h-[1rem] w-px shrink-0" aria-hidden />
        <AssigneeFilter filter={assignees} tasks={tasks} />
      </div>
      <div className="min-h-0 flex-1">
        <BoardView tasks={boardTasks} projectKey={projectKey} />
      </div>
    </div>
  ) : (
    <div className="h-full overflow-y-auto">
      <ListView
        tasks={tasks}
        recentlyClosed={recentlyClosed}
        projectKey={projectKey}
        toolbarExtra={toggle}
        assigneeFilter={assignees}
      />
    </div>
  )
}
