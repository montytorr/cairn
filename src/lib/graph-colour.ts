import type { GraphNode } from '@/lib/api/knowledge-graph'
import { projectColor } from '@/components/icons'

/**
 * What a node's colour says (CAIRN-361).
 *
 * Project is the default and the only one that names anything. The others
 * answer a question instead: how old is this, does anything read it, may it be
 * out of date. Each is a single hue ramp in flat colour, so the map stays one
 * quiet surface with one signal on it.
 */
export type ColourBy = 'project' | 'age' | 'recall' | 'health'

export const COLOUR_MODES: { key: ColourBy; label: string; hint: string }[] = [
  { key: 'project', label: 'Project', hint: 'Colour by project' },
  { key: 'age', label: 'Age', hint: 'Bright is recently written, dark has not been touched for months' },
  { key: 'recall', label: 'Recall', hint: 'Bright is returned or read by agents in the last 30 days' },
  { key: 'health', label: 'Health', hint: 'Amber may be stale, blue is unverified for two weeks or more' },
]

const DAY = 86_400_000
const RECALL_FULL = 8
const AGE_FULL_DAYS = 120

const COLD = [222, 12, 34] as const
const mix = (a: readonly number[], b: readonly number[], t: number): string => {
  const k = Math.max(0, Math.min(1, t))
  const [h, s, l] = a.map((v, i) => Math.round(v + ((b[i] as number) - v) * k))
  return `hsl(${h}, ${s}%, ${l}%)`
}

const FRESH = [168, 72, 56] as const
const HOT = [42, 92, 58] as const

/** Whole days, so the same hour of the same day always paints the same colour. */
export const ageDays = (node: Pick<GraphNode, 'updatedAt'>, now: number): number | null =>
  node.updatedAt ? Math.max(0, Math.floor((now - node.updatedAt) / DAY)) : null

/** The colour for a node, or null where the mode has no opinion and the project colour stands. */
export const nodeColour = (node: GraphNode, by: ColourBy, now: number): string | null => {
  if (by === 'project') return node.project ? projectColor(node.project) : null
  if (by === 'age') {
    const days = ageDays(node, now)
    return days === null ? mix(COLD, COLD, 0) : mix(FRESH, COLD, days / AGE_FULL_DAYS)
  }
  if (by === 'recall') return mix(COLD, HOT, Math.sqrt((node.recalls ?? 0) / RECALL_FULL))
  if (node.health === 'stale') return 'hsl(38, 92%, 56%)'
  if (node.health === 'unverified') return 'hsl(212, 78%, 62%)'
  return mix(COLD, COLD, 0)
}

/** The whole-day clock the colours are measured against. */
export const mapNow = (): number => Math.floor(Date.now() / DAY) * DAY
