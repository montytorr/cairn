import type { GraphNode } from '@/lib/api/knowledge-graph'

/**
 * One project or one world, lit against everything else.
 *
 * Cal asked whether the map should offer to GROUP by entity or by project.
 * The corpus says no to the project half of that: of a 200-entry sample, 12%
 * carry no project at all and the sizes run 61, 36, 24, 13, 10, 8 against a
 * median of three — eight of fifteen projects hold fewer than five entries.
 * Thirty-five gravitational wells over that distribution is confetti, not
 * regions, and the gathering force would have to fight the link springs much
 * harder to produce it. The links are what the page is for.
 *
 * The question underneath "group by project" is "where is my project on this
 * map", and that is a highlight. Nothing moves; the answer is better for it,
 * because you see how scattered a project's knowledge actually is against the
 * real structure rather than artificially clumped together.
 */
export type Spotlight =
  | { kind: 'project' | 'entity' | 'island' | 'find'; key: string }
  | null

const fold = (text: string): string => text.toLowerCase().replace(/[\s_-]+/g, ' ').trim()

/**
 * Whether an entry belongs to whatever is currently being picked out.
 *
 * `island` is the connected group (-1 is everything joined to nothing) and
 * `find` is what somebody typed, matched against title and slug with
 * separators folded so "map flat" finds `knowledge-map-flat` (CAIRN-361).
 */
export const inSpotlight = (
  node: Pick<GraphNode, 'project' | 'entity'> & Partial<Pick<GraphNode, 'island' | 'title' | 'slug'>>,
  lit: Spotlight,
): boolean => {
  if (!lit) return true
  if (lit.kind === 'project') return node.project === lit.key
  if (lit.kind === 'entity') return node.entity === lit.key
  if (lit.kind === 'island') return String(node.island ?? -1) === lit.key
  const words = fold(lit.key).split(' ').filter(Boolean)
  const haystack = fold(`${node.title ?? ''} ${node.slug ?? ''}`)
  return words.every((word) => haystack.includes(word))
}

/** What the caption says is lit: "N entries in X". */
export const spotlightName = (lit: NonNullable<Spotlight>): string =>
  lit.kind === 'island'
    ? lit.key === '-1'
      ? 'the entries joined to nothing'
      : 'this island'
    : lit.kind === 'find'
      ? `“${lit.key}”`
      : lit.key

/**
 * What is actually ON the map, which is not the same as what exists.
 *
 * Offering every project in the instance would list dozens that hold no
 * knowledge at all, and picking one would black the whole map out with no
 * indication that the answer is "nothing, yet". Counted so the control can
 * say how much it is about to light up.
 */
export const spotlightOptions = (
  nodes: readonly GraphNode[],
  titles: ReadonlyMap<string, string>,
): {
  projects: { key: string; label: string; count: number }[]
  entities: { key: string; label: string; count: number }[]
  islands: { key: string; label: string; count: number }[]
} => {
  const projects = new Map<string, number>()
  const entities = new Map<string, number>()
  for (const n of nodes) {
    if (n.project) projects.set(n.project, (projects.get(n.project) ?? 0) + 1)
    if (n.entity) entities.set(n.entity, (entities.get(n.entity) ?? 0) + 1)
  }
  const shape = (m: Map<string, number>, named: boolean) =>
    [...m.entries()]
      .map(([key, count]) => ({ key, label: named ? (titles.get(key) ?? key) : key, count }))
      // By name, because this is a list somebody reads down looking for one
      // they already have in mind — not a ranking.
      .sort((a, b) => a.label.localeCompare(b.label))
  const sizes = new Map<number, number>()
  for (const n of nodes) sizes.set(n.island, (sizes.get(n.island) ?? 0) + 1)
  // Largest first: unlike projects this is a ranking, and the big ones are
  // the ones worth walking into. A pair is not worth a menu entry.
  const islands = [...sizes.entries()]
    .filter(([island, count]) => island >= 0 && count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([island, count]) => ({ key: String(island), label: `Island of ${count}`, count }))
  const adrift = sizes.get(-1) ?? 0
  if (adrift > 0) islands.push({ key: '-1', label: 'Joined to nothing', count: adrift })
  return { projects: shape(projects, false), entities: shape(entities, true), islands }
}
