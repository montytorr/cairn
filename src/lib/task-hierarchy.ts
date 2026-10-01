import { admin } from '@/lib/db/client'

/**
 * Where a row sits among other tasks: its parent, its children, and what it
 * is waiting on (CAIRN-341).
 *
 * Sub-tasks (CAIRN-47) and dependencies (CAIRN-46) existed, and `cairn next`
 * already refused to offer a task with an unfinished dependency, but the lists
 * and boards drew neither: a child was a flat row with nothing to say whose,
 * and a task waiting on open work looked like any other todo.
 */
export type Hierarchy = {
  parent_ref: string | null
  /** Direct children, and how many of them are closed. Null when there are none. */
  children: { closed: number; total: number } | null
  /** Refs of the dependencies that are neither done nor cancelled. */
  waiting_on: string[]
}

const CLOSED = new Set(['done', 'cancelled'])

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/**
 * Three queries for a whole page, in two round trips, never one per row:
 * the children and the dependencies together, then one lookup that names
 * every parent and every open blocker at once. Refs are resolved here rather
 * than through a nested join, which the adapter is not trusted to keep.
 */
export const withHierarchy = async <T extends { id: string; parent_id: string | null }>(
  rows: T[],
): Promise<(T & Hierarchy)[]> => {
  if (rows.length === 0) return []
  const ids = [...new Set(rows.map((r) => r.id))]

  const [childRes, depRes] = await Promise.all([
    admin().from('tasks').select('parent_id, status').in('parent_id', ids),
    admin()
      .from('task_deps')
      .select('blocked_id, blocking_id, blocking:tasks!blocking_id(status)')
      .in('blocked_id', ids),
  ])

  const children = new Map<string, { closed: number; total: number }>()
  for (const c of (childRes.data ?? []) as { parent_id: string | null; status: string }[]) {
    if (!c.parent_id) continue
    const count = children.get(c.parent_id) ?? { closed: 0, total: 0 }
    count.total += 1
    if (CLOSED.has(c.status)) count.closed += 1
    children.set(c.parent_id, count)
  }

  const blockers = new Map<string, string[]>()
  for (const d of (depRes.data ?? []) as unknown as {
    blocked_id: string
    blocking_id: string
    blocking: { status: string } | { status: string }[] | null
  }[]) {
    const blocking = one(d.blocking)
    if (!blocking || CLOSED.has(blocking.status)) continue
    blockers.set(d.blocked_id, [...(blockers.get(d.blocked_id) ?? []), d.blocking_id])
  }

  const wanted = [
    ...new Set([
      ...rows.map((r) => r.parent_id).filter((id): id is string => Boolean(id)),
      ...[...blockers.values()].flat(),
    ]),
  ]
  const refs = new Map<string, string>()
  if (wanted.length > 0) {
    const { data } = await admin()
      .from('tasks')
      .select('id, number, project:projects!project_id!inner(key)')
      .in('id', wanted)
    for (const t of (data ?? []) as unknown as {
      id: string
      number: number
      project: { key: string } | { key: string }[] | null
    }[]) {
      const key = one(t.project)?.key
      if (key) refs.set(t.id, `${key}-${t.number}`)
    }
  }

  return rows.map((r) => ({
    ...r,
    parent_ref: r.parent_id ? (refs.get(r.parent_id) ?? null) : null,
    children: children.get(r.id) ?? null,
    waiting_on: (blockers.get(r.id) ?? [])
      .map((id) => refs.get(id))
      .filter((ref): ref is string => Boolean(ref))
      .sort(),
  }))
}
