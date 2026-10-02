import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@/lib/api/knowledge-graph'
import { CARD_MARGIN, CARD_OFFSET, hoverAnnouncement, hoverCardFor, placeCard } from './graph-hover'

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  slug: 'alpha',
  title: 'Alpha',
  project: 'CAIRN',
  entity: null,
  degree: 2,
  island: 0,
  x: 0,
  y: 0,
  ...over,
})

const index = (...nodes: GraphNode[]) => new Map(nodes.map((n) => [n.slug, n]))

describe('what the hover card says', () => {
  it('says nothing when nothing is under the pointer', () => {
    expect(hoverCardFor(null, index(node()), [])).toBeNull()
    expect(hoverCardFor('nobody', index(node()), [])).toBeNull()
  })

  it('names the entry, how joined it is, where it lives, and what it says', () => {
    const card = hoverCardFor('alpha', index(node({ excerpt: 'It says this.' })), [])
    expect(card).toEqual({
      kind: 'entry',
      title: 'Alpha',
      meta: '2 links · CAIRN',
      excerpt: 'It says this.',
    })
  })

  it('says when an entry is joined to nothing, and calls no project global', () => {
    const card = hoverCardFor('alpha', index(node({ degree: 0, project: null })), [])
    expect(card?.kind === 'entry' && card.meta).toBe('joined to nothing · global')
    expect(card?.kind === 'entry' && card.excerpt).toBeNull()
  })

  it('counts one link as one link', () => {
    const card = hoverCardFor('alpha', index(node({ degree: 1 })), [])
    expect(card?.kind === 'entry' && card.meta).toBe('1 link · CAIRN')
  })

  it('names the world by its title, and only when it is not the project again', () => {
    const titles = new Map([['dispofi', 'Dispofi']])
    const other = hoverCardFor('alpha', index(node({ project: 'API', entity: 'dispofi' })), [], titles)
    expect(other?.kind === 'entry' && other.meta).toBe('2 links · API · Dispofi')

    const same = hoverCardFor('alpha', index(node({ project: 'dispofi', entity: 'dispofi' })), [], titles)
    expect(same?.kind === 'entry' && same.meta).toBe('2 links · dispofi')
  })

  it('says a dangling reference was never written, and by how many', () => {
    const card = hoverCardFor('ghost', index(node()), [
      { slug: 'ghost', from: ['alpha', 'beta'], x: 0, y: 0 },
    ])
    expect(card).toEqual({ kind: 'missing', slug: 'ghost', detail: 'never written, referenced by 2' })
    expect(hoverAnnouncement(card)).toBe('ghost — never written, referenced by 2')
  })

  it('announces the same thing the card shows', () => {
    expect(hoverAnnouncement(hoverCardFor('alpha', index(node()), []))).toBe('Alpha · 2 links · CAIRN')
    expect(hoverAnnouncement(null)).toBe('')
  })
})

describe('where the hover card goes', () => {
  const bounds = { boundsWidth: 800, boundsHeight: 600 }
  const size = { width: 200, height: 80 }

  it('sits below and to the right of the pointer when there is room', () => {
    expect(placeCard({ x: 100, y: 100, ...size, ...bounds })).toEqual({
      left: 100 + CARD_OFFSET,
      top: 100 + CARD_OFFSET,
    })
  })

  it('flips to the left of the pointer near the right edge', () => {
    const { left, top } = placeCard({ x: 700, y: 100, ...size, ...bounds })
    expect(left).toBe(700 - CARD_OFFSET - size.width)
    expect(top).toBe(100 + CARD_OFFSET)
    expect(left + size.width).toBeLessThanOrEqual(bounds.boundsWidth - CARD_MARGIN)
  })

  it('flips above the pointer near the bottom edge', () => {
    const { left, top } = placeCard({ x: 100, y: 560, ...size, ...bounds })
    expect(left).toBe(100 + CARD_OFFSET)
    expect(top).toBe(560 - CARD_OFFSET - size.height)
  })

  it('flips both ways in the bottom-right corner', () => {
    const { left, top } = placeCard({ x: 790, y: 590, ...size, ...bounds })
    expect(left + size.width).toBeLessThanOrEqual(bounds.boundsWidth)
    expect(top + size.height).toBeLessThanOrEqual(bounds.boundsHeight)
  })

  it('stays inside a map too narrow for either side', () => {
    // A phone: the card is nearly as wide as the map, and neither side of the
    // pointer has room for it. Clamped to the margin rather than off the edge.
    const { left } = placeCard({ x: 150, y: 100, width: 300, height: 80, boundsWidth: 320, boundsHeight: 600 })
    expect(left).toBe(CARD_MARGIN)
  })

  it('never lands at a fractional pixel', () => {
    const { left, top } = placeCard({ x: 100.4, y: 100.6, ...size, ...bounds })
    expect(Number.isInteger(left)).toBe(true)
    expect(Number.isInteger(top)).toBe(true)
  })
})
