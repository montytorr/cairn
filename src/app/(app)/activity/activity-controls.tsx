'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Select } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'

const KINDS = [
  { value: 'task', label: 'Tasks filed' },
  { value: 'event', label: 'Changes' },
  { value: 'note', label: 'Notes' },
  { value: 'comment', label: 'Comments' },
  { value: 'session', label: 'Sessions' },
  { value: 'knowledge', label: 'Knowledge' },
]

export const ActivityControls = ({
  project,
  actor,
  kinds,
  projects,
  actors,
}: {
  project: string
  actor: string
  kinds: string
  projects: { key: string; title: string }[]
  actors: string[]
}) => {
  const router = useRouter()
  const [running, start] = useTransition()

  // Changing a filter drops `before`: the cursor belongs to the previous
  // query, and carrying it over lands the reader mid-way through a feed they
  // have not seen the start of.
  const push = (next: Record<string, string>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries({ project, actor, kinds, ...next })) if (v) params.set(k, v)
    start(() => router.replace(`/activity?${params}`))
  }

  return (
    <div className="border-border flex shrink-0 items-center gap-2 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none] sm:overflow-visible sm:px-4 [&::-webkit-scrollbar]:hidden">
      <span className="text-fg-subtle grid size-[14px] shrink-0 place-items-center">
        {running ? <Spinner size={13} /> : null}
      </span>

      <Select
        size="sm"
        value={kinds}
        onChange={(e) => push({ kinds: e.target.value })}
        aria-label="Filter by kind"
      >
        <option value="">Everything</option>
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </Select>

      <Select
        size="sm"
        value={project}
        onChange={(e) => push({ project: e.target.value })}
        aria-label="Filter by project"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.key} value={p.key}>
            {p.title}
          </option>
        ))}
      </Select>

      {actors.length > 0 && (
        <Select
          size="sm"
          value={actor}
          onChange={(e) => push({ actor: e.target.value })}
          aria-label="Filter by who"
        >
          <option value="">Anyone</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}
