'use client'

import { useEffect, useState } from 'react'
import { Select } from '@/components/ui/control'
import { FilterMenu } from '@/components/filter-menu'
import { usePeople } from '@/components/people-context'
import { TASK_PRIORITIES, TASK_TYPES } from '@/schemas/task'
import {
  GROUP_BY_VALUES,
  SWIMLANE_VALUES,
  UNASSIGNED,
  capitalize,
  type BoardFilters,
  type GroupBy,
  type Swimlane,
} from '@/lib/board-state'
import type { BoardProject } from '@/lib/board-data'

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  project: 'Project',
  agent: 'Agent',
  assignee: 'Assignee',
}

const SWIMLANE_LABEL: Record<Swimlane, string> = {
  none: 'None',
  project: 'Project',
  priority: 'Priority',
  agent: 'Agent',
  assignee: 'Assignee',
}

export const BoardToolbar = ({
  filters,
  onChange,
  projects,
  agentOptions,
  assigneeOptions,
}: {
  filters: BoardFilters
  onChange: (next: BoardFilters) => void
  projects: BoardProject[]
  agentOptions: string[]
  assigneeOptions: { value: string; label: string }[]
}) => {
  const [knownLabels, setKnownLabels] = useState<string[]>([])
  const { currentUserId } = usePeople()

  // Same one-shot fetch list-view.tsx uses: offering labels already in use is
  // what keeps the filter useful instead of a blank text box.
  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/v1/labels')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      setKnownLabels(((json?.data ?? []) as { label: string }[]).map((l) => l.label))
    }
    void load()
  }, [])

  const agentFilterOptions = [
    { value: UNASSIGNED, label: 'Unclaimed' },
    ...agentOptions.map((a) => ({ value: a, label: a })),
  ]

  return (
    // No overflow utility on this row, ever — see src/lib/overflow-guard.test.ts
    // and board-toolbar.test.ts. Setting one overflow axis to `auto` forces the
    // other from `visible` to `auto`, which is exactly what clipped the bulk
    // bar's own menus out of existence. This row wraps instead.
    <div className="border-border flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      <Select
        size="sm"
        value={filters.groupBy}
        onChange={(e) => onChange({ ...filters, groupBy: e.target.value as GroupBy })}
        className="w-[9.5rem]"
        aria-label="Group columns by"
      >
        {GROUP_BY_VALUES.map((g) => (
          <option key={g} value={g}>
            Group: {GROUP_BY_LABEL[g]}
          </option>
        ))}
      </Select>

      <Select
        size="sm"
        value={filters.swimlane}
        onChange={(e) => onChange({ ...filters, swimlane: e.target.value as Swimlane })}
        className="w-[9.5rem]"
        aria-label="Swimlanes"
      >
        {SWIMLANE_VALUES.filter((s) => s === 'none' || s !== filters.groupBy).map((s) => (
          <option key={s} value={s}>
            Lanes: {SWIMLANE_LABEL[s]}
          </option>
        ))}
      </Select>

      <span className="bg-border mx-0.5 h-[1rem] w-px shrink-0" aria-hidden />

      <FilterMenu
        label="Project"
        options={projects.map((p) => ({ value: p.key, label: p.title }))}
        selected={filters.projects}
        onChange={(v) => onChange({ ...filters, projects: v })}
      />
      <FilterMenu
        label="Type"
        options={TASK_TYPES.map((t) => ({ value: t, label: capitalize(t) }))}
        selected={filters.types}
        onChange={(v) => onChange({ ...filters, types: v })}
      />
      <FilterMenu
        label="Priority"
        options={TASK_PRIORITIES.map((p) => ({ value: p, label: capitalize(p) }))}
        selected={filters.priorities}
        onChange={(v) => onChange({ ...filters, priorities: v })}
      />
      <FilterMenu
        label="Label"
        options={knownLabels.map((l) => ({ value: l, label: l }))}
        selected={filters.labels}
        onChange={(v) => onChange({ ...filters, labels: v })}
      />
      <FilterMenu
        label="Agent"
        options={agentFilterOptions}
        selected={filters.agents}
        onChange={(v) => onChange({ ...filters, agents: v })}
      />
      {/* Mine by default, like the task lists; empty is "Everyone", a choice. */}
      <FilterMenu
        label="Assignee"
        summary={
          filters.assignees.length === 0
            ? 'Everyone'
            : filters.assignees.length === 1 && filters.assignees[0] === currentUserId
              ? 'Mine'
              : undefined
        }
        options={assigneeOptions}
        selected={filters.assignees}
        onChange={(v) => onChange({ ...filters, assignees: v })}
        reset="Everyone"
      />
    </div>
  )
}
