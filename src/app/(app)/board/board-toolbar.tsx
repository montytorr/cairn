'use client'

import { useEffect, useRef, useState } from 'react'
import { Select } from '@/components/ui/control'
import { cn } from '@/lib/utils'
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
}

const SWIMLANE_LABEL: Record<Swimlane, string> = {
  none: 'None',
  project: 'Project',
  priority: 'Priority',
  agent: 'Agent',
}

/**
 * A multi-select popover. The same outside-click/Escape pattern as
 * `label-editor.tsx` and `bulk-bar.tsx`'s `Action` menu — one look for every
 * menu in the app.
 */
const FilterMenu = ({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Filter by ${label}`}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
          selected.length > 0
            ? 'border-accent text-accent bg-accent-subtle'
            : 'border-border text-fg-muted hover:bg-surface-hover hover:text-fg',
        )}
      >
        {label}
        {selected.length > 0 && <span className="tabular">{selected.length}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="border-border bg-surface absolute top-[32px] left-0 z-50 max-h-[240px] w-[200px] overflow-y-auto rounded-md border py-1 shadow-xl"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected.includes(o.value)}
              onClick={() => toggle(o.value)}
              className="hover:bg-surface-hover flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
            >
              <input
                type="checkbox"
                readOnly
                tabIndex={-1}
                checked={selected.includes(o.value)}
                className="accent-accent size-[12px]"
              />
              <span className="text-fg-muted min-w-0 truncate text-[12px]">{o.label}</span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="text-fg-subtle px-2.5 py-1.5 text-[11px]">Nothing to filter by yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

export const BoardToolbar = ({
  filters,
  onChange,
  projects,
  agentOptions,
}: {
  filters: BoardFilters
  onChange: (next: BoardFilters) => void
  projects: BoardProject[]
  agentOptions: string[]
}) => {
  const [knownLabels, setKnownLabels] = useState<string[]>([])

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
    { value: UNASSIGNED, label: 'Unassigned' },
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
        className="w-[130px]"
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
        className="w-[130px]"
        aria-label="Swimlanes"
      >
        {SWIMLANE_VALUES.filter((s) => s === 'none' || s !== filters.groupBy).map((s) => (
          <option key={s} value={s}>
            Lanes: {SWIMLANE_LABEL[s]}
          </option>
        ))}
      </Select>

      <span className="bg-border mx-0.5 h-[16px] w-px shrink-0" aria-hidden />

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
    </div>
  )
}
