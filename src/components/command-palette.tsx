'use client'

import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Settings, FileJson, Search as SearchIcon, Moon, Plus } from 'lucide-react'
import { useTheme } from 'next-themes'
import { ProjectIcon, StatusIcon } from '@/components/icons'
import type { TaskStatus, TaskType } from '@/schemas/task'
import { useCreateTask } from '@/components/task-creation'

type Hit = {
  ref: string
  title: string
  type: TaskType
  status: TaskStatus
  resolved: boolean
  loose?: boolean
  tokens: number
}

/** Keyboard hint, rendered as the chips Linear shows on the right of a row. */
const Keys = ({ keys }: { keys: string[] }) => (
  <span className="ml-auto flex shrink-0 items-center gap-1">
    {keys.map((k, i) =>
      k === 'then' ? (
        <span key={i} className="text-fg-subtle text-[11px]">
          then
        </span>
      ) : (
        <kbd key={i} className="kbd">
          {k}
        </kbd>
      ),
    )}
  </span>
)

const itemClass =
  'flex h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] ' +
  'data-[selected=true]:bg-surface-hover'

const groupClass =
  '[&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:px-2.5 ' +
  '[&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 ' +
  '[&_[cmdk-group-heading]]:text-[11px]'

export const CommandPalette = ({ projects }: { projects: { key: string; title: string }[] }) => {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const { open: openCreate } = useCreateTask()
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
  // Derived, not cleared in an effect: setting state synchronously inside
  // useEffect triggers a cascading render, and this needs no state.
  const visibleHits = searchable ? hits : []

  useEffect(() => {
    if (!open || !searchable) return

    // Debounced and aborted on the next keystroke, so a slow response cannot
    // land after a newer query and overwrite it.
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
    }, 160)

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <Command
        className="bg-surface border-border pop w-full max-w-[560px] overflow-hidden rounded-lg border shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        shouldFilter={!searchable}
        loop
      >
        <div className="border-border flex items-center gap-2.5 border-b px-3.5">
          <SearchIcon size={14} className="text-fg-subtle shrink-0" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search tasks, or jump to a project…"
            className="placeholder:text-fg-subtle h-[46px] w-full bg-transparent text-[14px] outline-none"
          />
          {loading ? (
            <span className="text-fg-subtle shrink-0 text-[11px]">…</span>
          ) : (
            <kbd className="kbd shrink-0">esc</kbd>
          )}
        </div>

        <Command.List className="max-h-[340px] overflow-y-auto p-1.5">
          <Command.Empty className="text-fg-subtle px-2.5 py-8 text-center text-[12px]">
            {searchable ? 'Nothing found — this subject looks new.' : 'Type to search.'}
          </Command.Empty>

          {searchable && (
            <Command.Group heading="Search" className={groupClass}>
              <Command.Item
                value={`__all__ ${query}`}
                onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}`)}
                className={itemClass}
              >
                <SearchIcon size={13} className="text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate">
                  All results for <span className="text-fg-muted">{query.trim()}</span>
                </span>
                <span className="text-fg-subtle shrink-0 text-[10px]">
                  filters, resolutions, shareable link
                </span>
              </Command.Item>
            </Command.Group>
          )}

          {visibleHits.length > 0 && (
            <Command.Group heading="Tasks" className={groupClass}>
              {visibleHits.map((hit) => {
                const idx = hit.ref.lastIndexOf('-')
                const key = hit.ref.slice(0, idx)
                const number = hit.ref.slice(idx + 1)
                return (
                  <Command.Item
                    key={hit.ref}
                    value={hit.ref}
                    onSelect={() => go(`/projects/${key}/tasks/${number}`)}
                    className={itemClass}
                  >
                    <StatusIcon status={hit.status} size={13} />
                    <code className="text-fg-subtle w-[68px] shrink-0 truncate text-[11px] tabular">
                      {hit.ref}
                    </code>
                    <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                    {hit.resolved && (
                      <span className="bg-status-done size-[6px] shrink-0 rounded-full" title="Has a resolution" />
                    )}
                    {hit.loose && (
                      <span className="text-fg-subtle shrink-0 text-[10px]" title="Loose match">
                        ~
                      </span>
                    )}
                    <span className="text-fg-subtle shrink-0 text-[10px] tabular">
                      ~{hit.tokens}
                    </span>
                  </Command.Item>
                )
              })}
            </Command.Group>
          )}

          {!searchable && (
            <>
              <Command.Group heading="Create" className={groupClass}>
                <Command.Item
                  value="new task create"
                  onSelect={() => {
                    setOpen(false)
                    openCreate()
                  }}
                  className={itemClass}
                >
                  <Plus size={14} className="text-fg-subtle" />
                  New task
                  <Keys keys={['C']} />
                </Command.Item>
              </Command.Group>

              <Command.Group heading="Go to" className={groupClass}>
                <Command.Item value="settings" onSelect={() => go('/settings')} className={itemClass}>
                  <Settings size={14} className="text-fg-subtle" />
                  Settings
                  <Keys keys={['G', 'then', 'S']} />
                </Command.Item>
                <Command.Item value="api reference" onSelect={() => go('/api-docs')} className={itemClass}>
                  <FileJson size={14} className="text-fg-subtle" />
                  API reference
                  <Keys keys={['G', 'then', 'A']} />
                </Command.Item>
                <Command.Item
                  value="toggle theme"
                  onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                  className={itemClass}
                >
                  <Moon size={14} className="text-fg-subtle" />
                  Toggle theme
                  <Keys keys={['⌘', '⇧', 'L']} />
                </Command.Item>
              </Command.Group>

              {projects.length > 0 && (
                <Command.Group heading="Projects" className={groupClass}>
                  {projects.slice(0, 8).map((p) => (
                    <Command.Item
                      key={p.key}
                      value={`${p.key} ${p.title}`}
                      onSelect={() => go(`/projects/${p.key}`)}
                      className={itemClass}
                    >
                      <span className="text-fg-subtle">
                        <ProjectIcon size={13} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <code className="text-fg-subtle shrink-0 text-[10px]">{p.key}</code>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </>
          )}
        </Command.List>
      </Command>
    </div>
  )
}
