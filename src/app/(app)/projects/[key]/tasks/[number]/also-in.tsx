'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState(alsoProjects)

  const toggle = async (key: string) => {
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    setCurrent(next)
    setBusy(true)
    const res = await fetch(`/api/v1/tasks/${taskRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alsoProjects: next }),
    })
    setBusy(false)
    if (!res.ok) {
      setCurrent(current) // put it back rather than leave the panel lying
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-subtle text-[11px] tracking-wide uppercase">Also in</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-fg-subtle hover:text-fg text-[11px] transition-colors"
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>

      {current.length === 0 && !open && (
        <span className="text-fg-subtle text-[12px]">Only {homeKey}</span>
      )}

      {current.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {current.map((key) => (
            <span
              key={key}
              className="text-fg-muted inline-flex items-center gap-1 text-[12px]"
            >
              <ProjectIcon size={11} projectKey={key} />
              {key}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-1 flex flex-wrap gap-1">
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
                    'rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
                    on ? 'border-accent text-accent' : 'border-border text-fg-subtle hover:text-fg',
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
