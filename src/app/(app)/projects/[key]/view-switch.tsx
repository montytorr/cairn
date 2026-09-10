'use client'

import { useState } from 'react'
import { Columns3, List } from 'lucide-react'
import { BoardView } from './board-view'
import { ListView } from './list-view'
import { cn } from '@/lib/utils'
import type { TaskListItem } from '@/lib/data'

/**
 * Board or list, remembered per project in localStorage — the choice is a
 * per-viewer convenience, not shared state, so it belongs in the browser.
 */
export const ViewSwitch = ({
  tasks,
  projectKey,
}: {
  tasks: TaskListItem[]
  projectKey: string
}) => {
  const [view, setView] = useState<'board' | 'list'>(() => {
    try {
      return (localStorage.getItem(`cairn:view:${projectKey}`) as 'board' | 'list') ?? 'list'
    } catch {
      return 'list'
    }
  })

  const pick = (next: 'board' | 'list') => {
    setView(next)
    try {
      localStorage.setItem(`cairn:view:${projectKey}`, next)
    } catch {
      // private window or blocked storage; the choice just will not persist
    }
  }

  const button = (value: 'board' | 'list', Icon: typeof List, label: string) => (
    <button
      type="button"
      onClick={() => pick(value)}
      aria-pressed={view === value}
      title={label}
      className={cn(
        'grid size-6 place-items-center rounded transition-all duration-100',
        view === value
          ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
          : 'text-fg-subtle hover:text-fg',
      )}
    >
      <Icon size={14} />
    </button>
  )

  return (
    <div>
      <div className="border-border flex items-center gap-1 border-b px-3 py-1.5">
        {button('list', List, 'List view')}
        {button('board', Columns3, 'Board view')}
      </div>
      {view === 'board' ? (
        <div className="p-3">
          <BoardView tasks={tasks} projectKey={projectKey} />
        </div>
      ) : (
        <ListView tasks={tasks} projectKey={projectKey} />
      )}
    </div>
  )
}
