import type { GraphNode, MissingNode } from '@/lib/api/knowledge-graph'

/**
 * What the map's hover card says, and where it goes (CAIRN-349).
 *
 * Both used to be a bar fixed in the top-left corner. On a large screen that
 * bar sat a long way from the pointer and read like a static help line, so
 * hovering a node looked as if it did nothing at all. The card is drawn where
 * the reader is already looking; these are the parts of it that can be
 * decided without a DOM.
 */

export type HoverCard =
  | {
      kind: 'entry'
      title: string
      /** Links, then where it lives: "3 links · CAIRN · Dispofi". */
      meta: string
      excerpt: string | null
    }
  | { kind: 'missing'; slug: string; detail: string }

/**
 * The card for whatever is focused, or null when nothing is.
 *
 * The world is named only when it adds something: an entity whose key is the
 * project key repeated back is noise, which is the rule the bar had.
 */
export const hoverCardFor = (
  slug: string | null,
  nodes: ReadonlyMap<string, GraphNode>,
  missing: readonly MissingNode[],
  entityTitles: ReadonlyMap<string, string> = new Map(),
): HoverCard | null => {
  if (!slug) return null
  const node = nodes.get(slug)
  if (node) {
    const links =
      node.degree === 0 ? 'joined to nothing' : `${node.degree} link${node.degree === 1 ? '' : 's'}`
    const meta = [links]
    if (node.inbound) meta.push(`cited by ${node.inbound}`)
    meta.push(node.project ?? 'global')
    if (node.entity && node.entity !== node.project) {
      meta.push(entityTitles.get(node.entity) ?? node.entity)
    }
    if (node.health) meta.push(node.health === 'stale' ? 'may be stale' : 'unverified')
    return { kind: 'entry', title: node.title, meta: meta.join(' · '), excerpt: node.excerpt || null }
  }
  const gap = missing.find((m) => m.slug === slug)
  if (gap) {
    return { kind: 'missing', slug: gap.slug, detail: `never written, referenced by ${gap.from.length}` }
  }
  return null
}

/** What a screen reader hears, which is what the corner bar used to say. */
export const hoverAnnouncement = (card: HoverCard | null): string =>
  !card ? '' : card.kind === 'entry' ? `${card.title} · ${card.meta}` : `${card.slug} — ${card.detail}`

/** How far from the pointer the card sits, so the cursor never covers it. */
export const CARD_OFFSET = 14
/** How close the card may come to the edge of the map. */
export const CARD_MARGIN = 8

/**
 * Where the card's top-left corner goes, in the map's own coordinates.
 *
 * Below and to the right of the pointer, which is where a tooltip is expected
 * and where the scene's own title for the node is not (that sits above it).
 * Flipped to the other side of the pointer on whichever axis would run off
 * the map, and then clamped, so a card wider than the gap on both sides still
 * lands inside rather than half off the edge.
 */
export const placeCard = ({
  x,
  y,
  width,
  height,
  boundsWidth,
  boundsHeight,
  offset = CARD_OFFSET,
  margin = CARD_MARGIN,
}: {
  x: number
  y: number
  width: number
  height: number
  boundsWidth: number
  boundsHeight: number
  offset?: number
  margin?: number
}): { left: number; top: number } => {
  const along = (at: number, size: number, bound: number): number => {
    const after = at + offset
    const start = after + size > bound - margin ? at - offset - size : after
    return Math.round(Math.max(margin, Math.min(start, bound - margin - size)))
  }
  return { left: along(x, width, boundsWidth), top: along(y, height, boundsHeight) }
}
