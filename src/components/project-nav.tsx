'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 34 projects is too many for a plain list, so the nav filters.
 * Client-side only — the set is small and already in memory, and a round trip
 * per keystroke would be absurd.
 */
export const ProjectNav = ({ projects }: { projects: { key: string; title: string }[] }) => {
  const pathname = usePathname()
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    if (!query) return projects
    const q = query.toLowerCase()
    return projects.filter((p) => `${p.key} ${p.title}`.toLowerCase().includes(q))
  }, [projects, query])

  return (
    <nav className="flex min-h-0 flex-1 flex-col px-2">
      {projects.length > 8 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a project…"
          aria-label="Filter projects"
          className={
            'placeholder:text-fg-subtle mb-1 rounded-md bg-transparent px-2 py-1 text-[12px] ' +
            'outline-none focus:bg-surface'
          }
        />
      )}

      <ul className="-mx-0.5 flex-1 overflow-y-auto pb-2">
        {shown.map((p) => {
          const href = `/projects/${p.key}`
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <li key={p.key}>
              <Link
                href={href}
                className={cn(
                  'group flex items-baseline gap-2 rounded-md px-2 py-[5px] transition-colors duration-100',
                  active ? 'bg-surface text-fg' : 'text-fg-muted hover:bg-surface hover:text-fg',
                )}
              >
                <code
                  className={cn(
                    'w-11 shrink-0 truncate text-[10px]',
                    active ? 'text-accent' : 'text-fg-subtle',
                  )}
                >
                  {p.key}
                </code>
                <span className="truncate text-[12.5px]">{p.title}</span>
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
