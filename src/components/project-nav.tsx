'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ProjectIcon } from '@/components/icons'
import { Activity, BookOpen, Columns3, HeartPulse, History, Inbox, Search, X } from 'lucide-react'

/**
 * 34 projects is too many for a plain list, so the nav filters.
 * Client-side only — the set is small and already in memory, and a round trip
 * per keystroke would be absurd.
 */
export const ProjectNav = ({
  projects,
  onNavigate,
}: {
  projects: { key: string; title: string }[]
  onNavigate?: () => void
}) => {
  const pathname = usePathname()
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
    { href: '/sessions', label: 'Sessions', icon: History },
    { href: '/activity', label: 'Activity', icon: Activity },
    { href: '/vitals', label: 'Vitals', icon: HeartPulse },
  ]

  return (
    <nav className="flex min-h-0 flex-1 flex-col px-2">
      <ul className="-mx-0.5 mb-2">
        {links.map(({ href, label, icon: Icon }) => {
          // Knowledge alone has a child route (/knowledge/[slug]) that
          // should still light up this entry.
          const active =
            pathname === href || (href === '/knowledge' && pathname.startsWith('/knowledge/'))
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                className={cn(
                  'flex h-[28px] items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-75',
                  active
                    ? 'bg-surface-raised text-fg'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                <Icon size={13} aria-hidden />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>

      <span className="text-fg-subtle px-2 pb-1 text-[11px] font-medium">Projects</span>

      {projects.length > 8 && (
        <div className="relative mb-1">
          <Search
            size={11}
            aria-hidden
            className="text-fg-subtle pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a project…"
            aria-label="Filter projects"
            className="placeholder:text-fg-subtle hover:bg-surface focus:bg-surface focus:ring-ring/30 w-full rounded-md border border-transparent bg-transparent py-1 pr-2 pl-6 text-[12px] outline-none transition-colors focus:ring-2"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear the project filter"
              className="text-fg-subtle hover:text-fg absolute top-1/2 right-1.5 -translate-y-1/2"
            >
              <X size={11} aria-hidden />
            </button>
          )}
        </div>
      )}

      <ul className="-mx-0.5 flex-1 overflow-y-auto pb-2">
        {shown.map((p) => {
          const href = `/projects/${p.key}`
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <li key={p.key}>
              <Link
                href={href}
                onClick={onNavigate}
                className={cn(
                  'group flex h-[28px] items-center gap-2 rounded-md px-2 transition-colors duration-75',
                  active
                    ? 'bg-surface-raised text-fg'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                )}
              >
                <ProjectIcon size={13} projectKey={p.key} />
                <span className="truncate text-[13px]">{p.title}</span>
                <code className="text-fg-subtle ml-auto shrink-0 text-[10px]">{p.key}</code>
              </Link>
            </li>
          )
        })}

        {shown.length === 0 && (
          <li className="text-fg-subtle px-2 py-2 text-[11px]">No project matches.</li>
        )}
      </ul>
    </nav>
  )
}
