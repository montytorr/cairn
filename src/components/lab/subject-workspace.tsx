'use client'

import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { PANE } from '@/app/(app)/projects/[key]/tasks/[number]/styles'

export const SUBJECT_TABS = ['writeup', 'todos', 'notes', 'log', 'files', 'details'] as const
export type SubjectTab = (typeof SUBJECT_TABS)[number]

export const isSubjectTab = (value: string | undefined): value is SubjectTab =>
  (SUBJECT_TABS as readonly string[]).includes(value ?? '')

const LABELS: Record<SubjectTab, string> = {
  writeup: 'Write-up',
  todos: 'Todos',
  notes: 'Notes',
  log: 'Log',
  files: 'Files',
  details: 'Details',
}

/**
 * The subject page's body: the title block, a bar of sections, the open one
 * filling the column, and the properties rail beside it.
 *
 * Every section stays mounted and is only hidden, so a half-written note or a
 * board mid-scroll survives a look at the write-up. The open one is in the
 * URL (`?tab=todos`) through the history API rather than a navigation, so a
 * switch never waits on the server and a link can still open one directly.
 *
 * On a phone the rail is a section of its own, Details; from `lg` it is always
 * beside the page and that tab is gone. On a phone the whole page scrolls as
 * one; from `lg` the column and the rail scroll on their own.
 */
export const SubjectWorkspace = ({
  initialTab,
  counts,
  header,
  panels,
  rail,
}: {
  initialTab: SubjectTab
  counts: Partial<Record<SubjectTab, number>>
  header: React.ReactNode
  panels: Record<Exclude<SubjectTab, 'details'>, React.ReactNode>
  rail: React.ReactNode
}) => {
  const [tab, setTab] = useState<SubjectTab>(initialTab)

  const open = useCallback((next: SubjectTab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'writeup') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(window.history.state, '', url)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const visible = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
      (b) => b.offsetParent !== null,
    )
    const at = visible.findIndex((b) => b === document.activeElement)
    const next = visible[(at + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length]
    next?.focus()
    next?.click()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden lg:flex lg:overflow-hidden">
      <div className="min-w-0 lg:flex-1 lg:overflow-y-auto lg:overflow-x-hidden">
        <div className="mx-auto max-w-[51.25rem] px-4 pt-6 sm:px-6 lg:px-8">{header}</div>

        <div className="bg-bg border-border sticky top-0 z-20 mt-4 border-b">
          <div
            role="tablist"
            aria-label="Sections"
            onKeyDown={onKeyDown}
            className="mx-auto flex max-w-[51.25rem] items-center gap-0.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] sm:px-5 lg:px-7"
          >
            {SUBJECT_TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls={t === 'details' ? 'subject-rail' : `panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => open(t)}
                className={cn(
                  'inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui whitespace-nowrap transition-colors',
                  tab === t ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover',
                  t === 'details' && 'lg:hidden',
                )}
              >
                {LABELS[t]}
                {counts[t] ? (
                  <span className="bg-surface-raised text-fg-muted tabular rounded-full px-1.5 py-px text-meta leading-[1.4]">
                    {counts[t]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[51.25rem] px-4 pt-5 pb-16 sm:px-6 lg:px-8">
          {(Object.keys(panels) as (keyof typeof panels)[]).map((key) => (
            <div
              key={key}
              id={`panel-${key}`}
              role="tabpanel"
              aria-labelledby={`tab-${key}`}
              hidden={tab !== key}
            >
              {panels[key]}
            </div>
          ))}
        </div>
      </div>

      <aside
        id="subject-rail"
        aria-label="Details"
        className={cn(
          PANE,
          'overflow-x-hidden lg:block lg:w-[18rem] lg:shrink-0 lg:overflow-y-auto',
          tab === 'details' ? 'block' : 'hidden',
        )}
      >
        {rail}
      </aside>
    </div>
  )
}
