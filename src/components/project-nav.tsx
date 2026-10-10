'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ProjectIcon } from '@/components/icons'
import { Button, Input } from '@/components/ui/control'
import { useLabEnabled } from '@/components/lab/lab-context'
import {
  Activity, BookOpen, Columns3, FlaskConical, FolderKanban, HeartPulse, History, Inbox, Search, Waypoints, X,
} from 'lucide-react'

/**
 * 34 projects is too many for a plain list, so the nav filters.
 * Client-side only — the set is small and already in memory, and a round trip
 * per keystroke would be absurd.
 */
/**
 * The active entry's marker, drawn once per list and moved rather than drawn
 * on each row, so navigating slides it from the old entry to the new one.
 * Rows are a fixed 1.75rem, so its position is the index and nothing is
 * measured. Hidden when nothing in the list is active.
 */
const Marker = ({ index }: { index: number }) => (
  <span
    aria-hidden
    className={cn(
      'bg-surface-raised pointer-events-none absolute inset-x-0.5 top-0 h-[1.75rem] rounded-md',
      'transition-[transform,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)]',
      'before:bg-accent before:absolute before:inset-y-[0.375rem] before:-left-[2px] before:w-[2px] before:rounded-full',
      index < 0 && 'opacity-0',
    )}
    style={{ transform: `translateY(${Math.max(index, 0) * 1.75}rem)` }}
  />
)

export const ProjectNav = ({
  projects,
  onNavigate,
}: {
  projects: { key: string; title: string }[]
  onNavigate?: () => void
}) => {
  const pathname = usePathname()
  const labEnabled = useLabEnabled()
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    if (!query) return projects
    const q = query.toLowerCase()
    return projects.filter((p) => `${p.key} ${p.title}`.toLowerCase().includes(q))
  }, [projects, query])

  const links = [
    { href: '/', label: 'All tasks', icon: Inbox },
    { href: '/board', label: 'Board', icon: Columns3 },
    { href: '/search', label: 'Search', icon: Search },
    { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
    // The map had no entry here at all, so the only route to it was a single
    // unlined word in the corner of the knowledge list. It is the better
    // answer to "what do we know, and what is joined to nothing"; it should
    // not be the harder one to find.
    { href: '/knowledge/graph', label: 'Map', icon: Waypoints },
    // Only where the Lab is switched on: off, nothing lab-shaped is drawn.
    ...(labEnabled ? [{ href: '/lab', label: 'Lab', icon: FlaskConical }] : []),
    { href: '/sessions', label: 'Sessions', icon: History },
    { href: '/activity', label: 'Activity', icon: Activity },
    { href: '/vitals', label: 'Vitals', icon: HeartPulse },
    { href: '/projects', label: 'Projects', icon: FolderKanban },
  ]

  const isActive = (href: string) =>
    pathname === href ||
    // Knowledge alone has child routes (/knowledge/[slug]) that should still
    // light up this entry — but not the map, which has its own, or both would
    // be lit at once.
    (href === '/knowledge' && pathname.startsWith('/knowledge/') && pathname !== '/knowledge/graph') ||
    (href === '/lab' && pathname.startsWith('/lab/'))
  const activeLink = links.findIndex(({ href }) => isActive(href))
  const activeProject = shown.findIndex(
    (p) => pathname === `/projects/${p.key}` || pathname.startsWith(`/projects/${p.key}/`),
  )

  return (
    <nav className="flex min-h-0 flex-1 flex-col px-2">
      <ul className="relative -mx-0.5 mb-2">
        <Marker index={activeLink} />
        {links.map(({ href, label, icon: Icon }) => {
          const active = isActive(href)
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex h-[1.75rem] items-center gap-2 rounded-md px-2 text-ui',
                  'transition-colors duration-100 ease-[var(--ease)]',
                  // The marker (above) is the fill and the accent edge: a
                  // raised background alone is a very quiet way to answer
                  // "where am I" on a sidebar of twenty-odd entries.
                  active ? 'text-fg' : 'text-fg-muted hover:bg-surface-hover/70 hover:text-fg',
                )}
              >
                <Icon
                  size={13}
                  aria-hidden
                  className={cn(
                    'transition-[color,transform] duration-[var(--dur-2)] ease-[var(--ease-out)]',
                    active ? 'text-accent' : 'group-hover:scale-110',
                  )}
                />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>

      <span className="text-fg-subtle px-2 pb-1 text-meta font-medium">Projects</span>

      {projects.length > 8 && (
        <div className="relative mb-1">
          <Search
            size={13}
            aria-hidden
            className="text-fg-subtle pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2"
          />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a project…"
            aria-label="Filter projects"
            className="pr-9 pl-8"
          />
          {query && (
            <Button
              icon
              size="sm"
              variant="ghost"
              onClick={() => setQuery('')}
              aria-label="Clear the project filter"
              className="absolute top-0 right-0"
            >
              <X size={13} aria-hidden />
            </Button>
          )}
        </div>
      )}

      <ul className="relative -mx-0.5 flex-1 overflow-y-auto pb-2">
        <Marker index={activeProject} />
        {shown.map((p) => {
          const href = `/projects/${p.key}`
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <li key={p.key}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex h-[1.75rem] items-center gap-2 rounded-md px-2',
                  'transition-colors duration-100 ease-[var(--ease)]',
                  active ? 'text-fg' : 'text-fg-muted hover:bg-surface-hover/70 hover:text-fg',
                )}
              >
                <ProjectIcon size={13} projectKey={p.key} />
                <span className="truncate text-ui">{p.title}</span>
                <code className="text-fg-subtle ml-auto shrink-0 text-meta">{p.key}</code>
              </Link>
            </li>
          )
        })}

        {shown.length === 0 && (
          <li className="text-fg-subtle px-2 py-2 text-meta">No project matches.</li>
        )}
      </ul>
    </nav>
  )
}
