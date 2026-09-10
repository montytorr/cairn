'use client'

import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { StatusBadge, TypeBadge } from '@/components/badges'
import type { TaskStatus, TaskType } from '@/schemas/task'

type Hit = {
  ref: string
  title: string
  type: TaskType
  status: TaskStatus
  resolved: boolean
  tokens: number
}

/**
 * ⌘K search over the same endpoint the agents use, so the human and the agents
 * are looking at one index rather than two implementations of "find prior work".
 */
export const CommandPalette = ({ projects }: { projects: { key: string; title: string }[] }) => {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const searchable = query.trim().length >= 2
  // Derived rather than cleared in an effect: setting state synchronously
  // inside useEffect triggers a cascading render, and this needs no state.
  const visibleHits = searchable ? hits : []

  useEffect(() => {
    if (!open || !searchable) return

    // Debounced, and aborted on the next keystroke so results cannot arrive
    // out of order and overwrite a newer query.
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
        const payload = await res.json()
        setHits(payload.success ? payload.data.results : [])
      } catch {
        // aborted or offline; leave the previous results in place
      } finally {
        setLoading(false)
      }
    }, 180)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, open, searchable])

  const go = (path: string) => {
    setOpen(false)
    setQuery('')
    router.push(path)
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <Command
        className="bg-surface border-border w-full max-w-lg overflow-hidden rounded-lg border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        shouldFilter={false}
        loop
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search size={14} className="text-fg-subtle shrink-0" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search prior work, or jump to a project…"
            className="placeholder:text-fg-subtle w-full bg-transparent py-3 text-sm outline-none"
          />
          {loading && <span className="text-fg-subtle text-[11px]">…</span>}
        </div>

        <Command.List className="max-h-80 overflow-y-auto p-1.5">
          <Command.Empty className="text-fg-subtle px-2 py-6 text-center text-xs">
            {query.trim().length < 2 ? 'Type to search.' : 'Nothing found — this looks new.'}
          </Command.Empty>

          {visibleHits.length > 0 && (
            <Command.Group
              heading="Tasks"
              className="[&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase"
            >
              {visibleHits.map((hit) => {
                const [key] = hit.ref.split('-')
                const number = hit.ref.slice((key?.length ?? 0) + 1)
                return (
                  <Command.Item
                    key={hit.ref}
                    value={hit.ref}
                    onSelect={() => go(`/projects/${key}/tasks/${number}`)}
                    className="data-[selected=true]:bg-surface-raised flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm"
                  >
                    <code className="text-fg-subtle w-16 shrink-0 text-[11px]">{hit.ref}</code>
                    <TypeBadge type={hit.type} compact />
                    <StatusBadge status={hit.status} compact />
                    <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                    {hit.resolved && (
                      <span className="text-status-done shrink-0 text-[11px]">answered</span>
                    )}
                  </Command.Item>
                )
              })}
            </Command.Group>
          )}

          {query.trim().length < 2 && projects.length > 0 && (
            <Command.Group
              heading="Projects"
              className="[&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase"
            >
              {projects.map((p) => (
                <Command.Item
                  key={p.key}
                  value={p.key}
                  onSelect={() => go(`/projects/${p.key}`)}
                  className="data-[selected=true]:bg-surface-raised flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-2 text-sm"
                >
                  <code className="text-fg-subtle text-[11px]">{p.key}</code>
                  <span>{p.title}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}
