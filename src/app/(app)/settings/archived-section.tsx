'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectIcon } from '@/components/icons'

export type ArchivedProject = { id: string; key: string; title: string; task_counter: number }

/**
 * The only place archived projects are visible. They are deliberately gone
 * from the sidebar, the command palette and the home page — an archive that
 * still shows up everywhere is just a label.
 */
export const ArchivedSection = ({ projects }: { projects: ArchivedProject[] }) => {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  const restore = async (key: string) => {
    setBusy(key)
    const res = await fetch(`/api/v1/projects/${key}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    setBusy(null)
    if (res.ok) router.refresh()
  }

  return (
    <section>
      <h2 className="text-fg text-[13px] font-medium">Archived projects</h2>
      <p className="text-fg-subtle mt-1 text-[12px]">
        Hidden from the sidebar and the palette. Their tasks are untouched and still turn up
        in search.
      </p>

      {projects.length === 0 ? (
        <p className="text-fg-subtle border-border mt-3 rounded-md border border-dashed px-3 py-4 text-center text-[12px]">
          Nothing archived.
        </p>
      ) : (
        <ul className="border-border mt-3 divide-y divide-[var(--border)] rounded-md border">
          {projects.map((p) => (
            <li key={p.id} className="flex h-[38px] items-center gap-2 px-3">
              <ProjectIcon size={13} projectKey={p.key} />
              <span className="text-fg min-w-0 flex-1 truncate text-[13px]">{p.title}</span>
              <span className="text-fg-subtle tabular shrink-0 text-[11px]">
                {p.task_counter} tasks
              </span>
              <button
                type="button"
                disabled={busy === p.key}
                onClick={() => void restore(p.key)}
                className="text-fg-muted hover:text-fg hover:bg-surface-hover shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors disabled:opacity-50"
              >
                {busy === p.key ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
