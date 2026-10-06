'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { BulkBar } from '../projects/[key]/bulk-bar'
import { applySelection } from '@/lib/selection'
import { cn } from '@/lib/utils'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'
import { Highlight, queryTerms } from './highlight'

export type ResultRow = {
  id: string
  number: number
  title: string
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  description: string | null
  project_key: string
}

const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'Fixed',
  'wont-fix': "Won't fix",
  duplicate: 'Duplicate',
  'not-reproducible': 'Not reproducible',
  superseded: 'Superseded',
  answered: 'Answered',
}

/**
 * Search results are ranked, so they keep their own row rather than borrowing
 * the list view's — grouping them by status would throw away the ordering,
 * which is the entire point of searching. Selection is added here instead.
 */
export const SearchResults = ({ rows, query = '' }: { rows: ResultRow[]; query?: string }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastPicked = useRef<string | null>(null)
  const ordered = rows.map((r) => r.id)

  const onToggle = (id: string, shiftKey: boolean) => {
    // Anchor read before it moves: a state updater runs when React processes
    // the update, by which time `lastPicked.current` would already be the row
    // just clicked and every range would collapse to a single toggle.
    const anchor = lastPicked.current
    lastPicked.current = id
    setSelected((prev) => applySelection(prev, ordered, id, { shiftKey, anchor }))
  }

  const selecting = selected.size > 0
  const terms = queryTerms(query)

  return (
    <div>
      <div className="stagger">
        {rows.map((row) => {
          const ref = `${row.project_key}-${row.number}`
          const isSelected = selected.has(row.id)
          return (
            <div
              key={row.id}
              className={cn(
                'group border-border/70 relative select-none border-b px-2.5 py-2.5 last:border-0 md:px-4',
                isSelected
                  ? 'bg-accent-subtle shadow-[inset_2px_0_0_var(--accent)] transition-colors duration-[var(--dur-1)]'
                  : 'row-hover',
              )}
            >
              <Link
                href={`/projects/${row.project_key}/tasks/${row.number}`}
                prefetch
                aria-label={row.title}
                className="absolute inset-0 z-0"
              />

              <div className="pointer-events-none relative flex items-center gap-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`Select ${row.title}`}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onToggle(row.id, e.shiftKey)
                  }}
                  className={cn(
                    'pointer-events-auto relative z-10 grid size-[1.125rem] shrink-0 place-items-center transition-opacity',
                    isSelected || selecting
                      ? 'opacity-100'
                      : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-[0.875rem] place-items-center rounded-[0.25rem] border transition-colors',
                      isSelected
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border-strong bg-surface hover:border-accent',
                    )}
                  >
                    {isSelected && (
                      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                        <path
                          d="M1.5 5.2l2.2 2.2L8.5 2.6"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    )}
                  </span>
                </button>

                <PriorityIcon priority={row.priority as TaskPriority} />
                <StatusIcon status={row.status as TaskStatus} />
                <span className="text-fg min-w-0 flex-1 truncate text-ui">
                  <Highlight text={row.title} terms={terms} />
                </span>
                <span className="hidden shrink-0 sm:block">
                  <TypePill type={row.type as TaskType} />
                </span>
                <ProjectIcon size={12} projectKey={row.project_key} />
                <code className="text-fg-subtle tabular hidden w-[5rem] shrink-0 truncate text-right text-meta sm:block">
                  {ref}
                </code>
              </div>

              {/* A recorded resolution is the payload — show it here so the
                  answer can be read without opening anything. */}
              {row.resolution ? (
                <p className="text-fg-muted pointer-events-none relative mt-1.5 line-clamp-2 pl-[3.875rem] text-ui leading-relaxed">
                  <span className="text-status-done mr-1.5 text-meta font-medium">
                    {RESOLUTION_LABEL[row.resolution_kind ?? ''] ?? 'Resolved'}
                  </span>
                  {row.resolution}
                </p>
              ) : row.description ? (
                <p className="text-fg-subtle pointer-events-none relative mt-1 line-clamp-1 pl-[3.875rem] text-ui">
                  {row.description}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>

      {selecting && (
        <BulkBar
          ids={ordered.filter((id) => selected.has(id))}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  )
}
