/**
 * A list's rows with each child directly under its parent (CAIRN-341).
 *
 * Only within the rows given: a child whose parent is in another status group,
 * or filtered out, stays where it is as an ordinary row — its "↳ parent"
 * marker says whose it is. Order is otherwise the order given, so the list's
 * own sorting still decides which parent comes first.
 */
export type NestedRow<T> = {
  task: T
  depth: number
  /** Children of this row present in the same list, collapsed or not. */
  nested: number
}

export const nestTasks = <T extends { id: string; parent_id?: string | null }>(
  items: T[],
  collapsed: ReadonlySet<string> = new Set(),
): NestedRow<T>[] => {
  const present = new Set(items.map((t) => t.id))
  const childrenOf = new Map<string, T[]>()
  for (const t of items) {
    if (!t.parent_id || !present.has(t.parent_id) || t.parent_id === t.id) continue
    childrenOf.set(t.parent_id, [...(childrenOf.get(t.parent_id) ?? []), t])
  }

  const out: NestedRow<T>[] = []
  // The database refuses a cycle; this refuses to loop on one regardless.
  const placed = new Set<string>()
  const place = (t: T, depth: number) => {
    if (placed.has(t.id)) return
    placed.add(t.id)
    const kids = childrenOf.get(t.id) ?? []
    out.push({ task: t, depth, nested: kids.length })
    if (collapsed.has(t.id)) {
      // Still placed, so they do not resurface as roots further down.
      const hide = (k: T) => {
        if (placed.has(k.id)) return
        placed.add(k.id)
        for (const g of childrenOf.get(k.id) ?? []) hide(g)
      }
      for (const k of kids) hide(k)
      return
    }
    for (const k of kids) place(k, depth + 1)
  }

  for (const t of items) {
    const parentHere = t.parent_id && t.parent_id !== t.id && present.has(t.parent_id)
    if (!parentHere) place(t, 0)
  }
  // Anything left belongs to a cycle with no root; show it flat rather than lose it.
  for (const t of items) place(t, 0)
  return out
}
