'use client'

import { useMemo, useState } from 'react'
import { FilterMenu } from '@/components/filter-menu'
import { usePeople } from '@/components/people-context'
import { parseAssignees, withAssignees } from '@/lib/assignee-filter'

/**
 * Whose tasks are shown, defaulting to the viewer's (CAIRN-339).
 *
 * Seeded from the page's own `assignee` search param, which the server passes
 * down, so the first render already matches what hydration will see. Written
 * back with replaceState, as the board writes its filters: a reload or a
 * copied link keeps the choice.
 */
export const useAssigneeFilter = (initial: string | null | undefined) => {
  const { currentUserId } = usePeople()
  const [selected, setSelectedState] = useState(() => parseAssignees(initial, currentUserId))

  const setSelected = (next: string[]) => {
    setSelectedState(next)
    if (typeof window === 'undefined') return
    const qs = withAssignees(window.location.search, next, currentUserId)
    window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
  }

  return { selected, setSelected, me: currentUserId }
}

export type AssigneeFilterState = ReturnType<typeof useAssigneeFilter>

/**
 * Everyone who can be assigned work, the viewer first, plus anyone the tasks
 * name who is no longer in that list — a disabled user's open tasks still
 * have to be findable.
 */
export const useAssigneeOptions = (tasks: { assignee_user_id: string; assignee?: { name: string } | null }[]) => {
  const { people, currentUserId } = usePeople()
  return useMemo(() => {
    const names = new Map(people.filter((p) => p.active).map((p) => [p.id, p.name]))
    for (const t of tasks) {
      if (!names.has(t.assignee_user_id)) names.set(t.assignee_user_id, t.assignee?.name ?? 'Former member')
    }
    const others = [...names.entries()]
      .filter(([id]) => id !== currentUserId)
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return currentUserId ? [{ value: currentUserId, label: 'Me' }, ...others] : others
  }, [people, currentUserId, tasks])
}

export const AssigneeFilter = ({
  filter,
  tasks,
}: {
  filter: AssigneeFilterState
  tasks: { assignee_user_id: string; assignee?: { name: string } | null }[]
}) => {
  const options = useAssigneeOptions(tasks)
  const { selected, setSelected, me } = filter
  const summary =
    selected.length === 0
      ? 'Everyone'
      : selected.length === 1
        ? selected[0] === me
          ? 'Mine'
          : (options.find((o) => o.value === selected[0])?.label ?? '1 person')
        : `${selected.length} people`

  return (
    <FilterMenu
      label="Assignee"
      summary={summary}
      options={options}
      selected={selected}
      onChange={setSelected}
      reset="Everyone"
    />
  )
}
