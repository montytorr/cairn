'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useMutate } from '@/lib/api/use-mutate'
import { ROW, ROW_LABEL } from './styles'

/**
 * The projects a task belongs to beyond the one that owns its ref.
 *
 * Work that spans repos is filed once, in whichever project leads it, and
 * linked into the others — so it keeps a single ref and a single resolution
 * instead of being duplicated and half-closed in three places. Until now this
 * was `cairn update --also-project` and nothing else; a person could see the
 * effect on a project list but had no way to cause it.
 */
export const AlsoIn = ({
  taskRef,
  homeKey,
  alsoProjects,
  projects,
}: {
  taskRef: string
  homeKey: string
  alsoProjects: string[]
  projects: { key: string; title: string }[]
}) => {
  const router = useRouter()
  const request = useMutate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState(alsoProjects)
  // Held in state so a toggle can be applied optimistically and put back on
  // failure; reconciled here so a change made elsewhere still lands.
  const [prevAlso, setPrevAlso] = useState(alsoProjects)
  if (alsoProjects !== prevAlso) {
    setPrevAlso(alsoProjects)
    setCurrent(alsoProjects)
  }

  const toggle = async (key: string) => {
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    setCurrent(next)
    setBusy(true)
    const result = await request(`/api/v1/tasks/${taskRef}`, {
      method: 'PATCH',
      body: { alsoProjects: next },
    })
    setBusy(false)
    if (!result.ok) {
      setCurrent(current) // put it back rather than leave the panel lying
      return
    }
    router.refresh()
  }

  return (
    <div className="group/dep flex flex-col gap-1">
      <div className={cn(ROW, 'justify-between')}>
        <span className={ROW_LABEL}>Also in</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {current.length === 0 && !open ? (
            <span className="text-fg-subtle text-meta">Only here</span>
          ) : (
            current.map((key) => (
              <span
                key={key}
                className="border-border text-fg-muted inline-flex h-[1.25rem] shrink-0 items-center gap-1 rounded-full border pr-2 pl-1.5 text-meta"
              >
                <ProjectIcon size={11} projectKey={key} />
                {key}
              </span>
            ))
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'text-fg-subtle hover:text-fg hover:bg-surface-hover shrink-0 rounded px-1.5 py-px text-meta transition-[opacity,color,background-color] duration-[var(--dur-1)]',
            open ? 'opacity-100' : 'opacity-0 group-hover/dep:opacity-100 focus-visible:opacity-100',
          )}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>

      {open && (
        <div
          className="pop mt-1 flex flex-wrap gap-1"
          style={{ '--origin': 'top left' } as React.CSSProperties}
        >
          {projects
            .filter((p) => p.key !== homeKey)
            .map((p) => {
              const on = current.includes(p.key)
              return (
                <button
                  key={p.key}
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(p.key)}
                  aria-pressed={on}
                  title={p.title}
                  className={cn(
                    'rounded-full border px-1.5 py-0.5 font-mono text-meta transition-[color,border-color,background-color] duration-[var(--dur-1)] ease-[var(--ease-out)]',
                    // On is marked flatly: the accent at the rim and in the
                    // text, over the accent's subtle fill.
                    on
                      ? 'border-accent/70 text-accent bg-accent-subtle'
                      : 'border-border text-fg-subtle hover:text-fg hover:border-border-strong hover:bg-surface-hover',
                  )}
                >
                  {p.key}
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}
