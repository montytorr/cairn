'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'

/**
 * Filters live in the URL, like every other filter bar in the app — and,
 * deliberately, changing either one drops any `before` cursor: a filtered
 * page picking up a pagination cursor computed against the unfiltered set
 * would skip or repeat rows.
 */
export const SessionControls = ({
  project,
  agent,
  projects,
  agents,
}: {
  project: string
  agent: string
  projects: { key: string; title: string }[]
  agents: string[]
}) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const push = (next: Partial<{ project: string; agent: string }>) => {
    const merged = { project, agent, ...next }
    const params = new URLSearchParams()
    if (merged.project) params.set('project', merged.project)
    if (merged.agent) params.set('agent', merged.agent)
    startTransition(() => router.replace(`/sessions?${params.toString()}`))
  }

  return (
    <div className="border-border flex h-[42px] shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      {pending && <Spinner size={13} />}
      <Select
        size="sm"
        value={project}
        onChange={(e) => push({ project: e.target.value })}
        aria-label="Filter by project"
        className="w-auto"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.key} value={p.key}>
            {p.title}
          </option>
        ))}
      </Select>

      <Select
        size="sm"
        value={agent}
        onChange={(e) => push({ agent: e.target.value })}
        aria-label="Filter by agent"
        className="w-auto"
      >
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </Select>

      {(project || agent) && (
        <button
          type="button"
          onClick={() => router.replace('/sessions')}
          className="text-fg-subtle hover:text-fg text-[12px] transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  )
}
