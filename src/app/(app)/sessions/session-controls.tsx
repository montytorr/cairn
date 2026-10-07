'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Select } from '@/components/ui/control'
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
    <div className="border-border/70 flex min-h-[2.625rem] shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 sm:px-4">
      {pending && <Spinner size={13} />}
      <Select
        size="sm"
        value={project}
        onChange={(e) => push({ project: e.target.value })}
        aria-label="Filter by project"
        className="max-w-[14rem]"
        emptyLabel={projects.length === 0 ? 'No projects yet' : undefined}
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
        className="max-w-[14rem]"
        emptyLabel={agents.length === 0 ? 'No agents yet' : undefined}
      >
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </Select>

      {(project || agent) && (
        <Button size="sm" variant="quiet" onClick={() => router.replace('/sessions')}>
          Clear
        </Button>
      )}
    </div>
  )
}
