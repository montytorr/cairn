'use client'

import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Settings, FileJson, FlaskConical, KeyRound, Search as SearchIcon, Moon, Plus } from 'lucide-react'
import { useTheme } from 'next-themes'
import { ProjectIcon, StatusIcon } from '@/components/icons'
import type { TaskStatus, TaskType } from '@/schemas/task'
import { useCreateTask } from '@/components/task-creation'
import { EmptyState } from '@/components/empty-state'
import { Spinner } from '@/components/spinner'

type Hit = {
  /** `subject` for a Lab subject, which the search puts first when asked for `LAB-12`. */
  kind?: string
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
        <span key={i} className="text-fg-subtle text-meta">
          then
        </span>
      ) : (
        <kbd key={i} className="kbd inline-flex">
          {k}
        </kbd>
      ),
    )}
  </span>
)

// The selected row carries the trail marker: the accent-subtle fill and a
// two-pixel edge of the accent at the left.
const itemClass =
  'group relative flex h-[2.375rem] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-ui ' +
  'transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)] ' +
  'data-[selected=true]:bg-accent-subtle ' +
  'before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-full before:bg-accent ' +
  'before:opacity-0 before:transition-opacity before:duration-[var(--dur-1)] ' +
  'data-[selected=true]:before:opacity-100'

const iconClass = 'text-fg-subtle transition-colors duration-[var(--dur-1)] group-data-[selected=true]:text-accent'

const groupClass =
  '[&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:px-2.5 ' +
  '[&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 ' +
  '[&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium ' +
  '[&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:uppercase'

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
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div className="scrim absolute inset-0" aria-hidden />
      <Command
        className="border-border bg-surface raised-lg enter-pop relative w-full max-w-[35rem] overflow-hidden rounded-xl border"
        style={{ '--origin': 'top' } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
        shouldFilter={!searchable}
        loop
      >
        <div className="border-border relative flex items-center border-b p-2.5">
          <SearchIcon size={15} className="text-fg-subtle pointer-events-none absolute left-5 z-10 shrink-0" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search tasks, or jump to a project…"
            className="w-full pr-14 pl-9"
          />
          {loading ? (
            <span className="text-fg-subtle pointer-events-none absolute right-5 shrink-0">
              <Spinner size={12} />
            </span>
          ) : (
            <kbd className="kbd pointer-events-none absolute right-5 inline-flex shrink-0">esc</kbd>
          )}
        </div>

        <Command.List className="max-h-[21.25rem] overflow-y-auto p-1.5 pb-2">
          <Command.Empty>
            <EmptyState
              compact
              title={searchable ? 'Nothing found — this subject looks new.' : 'Type to search.'}
            />
          </Command.Empty>

          {searchable && (
            <Command.Group heading="Search" className={groupClass}>
              <Command.Item
                value={`__all__ ${query}`}
                onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}`)}
                className={itemClass}
              >
                <SearchIcon size={13} className={iconClass} />
                <span className="min-w-0 flex-1 truncate">
                  All results for <span className="text-fg-muted">{query.trim()}</span>
                </span>
                <span className="text-fg-subtle shrink-0 text-meta">
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
                const subject = hit.kind === 'subject'
                return (
                  <Command.Item
                    key={hit.ref}
                    value={hit.ref}
                    onSelect={() => go(subject ? `/lab/subjects/${number}` : `/projects/${key}/tasks/${number}`)}
                    className={itemClass}
                  >
                    {subject ? (
                      <FlaskConical size={13} aria-hidden style={{ color: 'var(--status-in-review)' }} />
                    ) : (
                      <StatusIcon status={hit.status} size={13} />
                    )}
                    <code className="text-fg-subtle w-[4.25rem] shrink-0 truncate text-meta tabular">
                      {hit.ref}
                    </code>
                    <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                    {hit.resolved && (
                      <span className="bg-status-done size-[0.375rem] shrink-0 rounded-full" title="Has a resolution" />
                    )}
                    {hit.loose && (
                      <span className="text-fg-subtle shrink-0 text-meta" title="Loose match">
                        ~
                      </span>
                    )}
                    <span className="text-fg-subtle shrink-0 text-meta tabular">
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
                  <Plus size={14} className={iconClass} />
                  New task
                  <Keys keys={['C']} />
                </Command.Item>
              </Command.Group>

              <Command.Group heading="Go to" className={groupClass}>
                <Command.Item value="settings" onSelect={() => go('/settings')} className={itemClass}>
                  <Settings size={14} className={iconClass} />
                  Settings
                  <Keys keys={['G', 'then', 'S']} />
                </Command.Item>
                <Command.Item value="your agent keys revoke" onSelect={() => go('/settings/keys')} className={itemClass}>
                  <KeyRound size={14} className={iconClass} />
                  Your agent keys
                </Command.Item>
                <Command.Item value="api reference" onSelect={() => go('/api-docs')} className={itemClass}>
                  <FileJson size={14} className={iconClass} />
                  API reference
                  <Keys keys={['G', 'then', 'A']} />
                </Command.Item>
                <Command.Item
                  value="toggle theme"
                  onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                  className={itemClass}
                >
                  <Moon size={14} className={iconClass} />
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
                      <ProjectIcon size={13} projectKey={p.key} />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <code className="text-fg-subtle shrink-0 text-meta">{p.key}</code>
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
