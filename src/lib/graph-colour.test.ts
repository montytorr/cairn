import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@/lib/api/knowledge-graph'
import { ageDays, nodeColour } from '@/lib/graph-colour'
import { inSpotlight, spotlightOptions } from '@/lib/graph-spotlight'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 8)
const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  slug: 'knowledge-map-flat',
  title: 'The flat map',
  project: 'CAIRN',
  entity: null,
  degree: 2,
  island: 0,
  x: 0,
  y: 0,
  ...over,
})

describe('colour by', () => {
  it('leaves project colour to the project and grey to the global entry', () => {
    expect(nodeColour(node({ project: null }), 'project', NOW)).toBeNull()
    expect(nodeColour(node(), 'project', NOW)).toMatch(/\S/)
  })

  it('paints a fresh entry differently from a four-month-old one', () => {
    const fresh = nodeColour(node({ updatedAt: NOW - DAY }), 'age', NOW)
    const old = nodeColour(node({ updatedAt: NOW - 200 * DAY }), 'age', NOW)
    expect(fresh).not.toEqual(old)
  })

  it('measures age in whole days', () => {
    expect(ageDays({ updatedAt: NOW - DAY * 3 - 1000 }, NOW)).toBe(3)
    expect(ageDays({}, NOW)).toBeNull()
  })

  it('warms with recall and marks health', () => {
    expect(nodeColour(node({ recalls: 0 }), 'recall', NOW)).not.toEqual(nodeColour(node({ recalls: 9 }), 'recall', NOW))
    const stale = nodeColour(node({ health: 'stale' }), 'health', NOW)
    const unverified = nodeColour(node({ health: 'unverified' }), 'health', NOW)
    const fine = nodeColour(node(), 'health', NOW)
    expect(new Set([stale, unverified, fine]).size).toBe(3)
  })
})

describe('find and island spotlight', () => {
  it('matches every typed word against title and slug, separators folded', () => {
    expect(inSpotlight(node(), { kind: 'find', key: 'map flat' })).toBe(true)
    expect(inSpotlight(node(), { kind: 'find', key: 'FLAT_map' })).toBe(true)
    expect(inSpotlight(node(), { kind: 'find', key: 'map scene' })).toBe(false)
  })

  it('lights one island, and -1 is the entries joined to nothing', () => {
    expect(inSpotlight(node({ island: 3 }), { kind: 'island', key: '3' })).toBe(true)
    expect(inSpotlight(node({ island: 3 }), { kind: 'island', key: '4' })).toBe(false)
    expect(inSpotlight(node({ island: -1 }), { kind: 'island', key: '-1' })).toBe(true)
  })

  it('offers the big islands largest first and the orphans last, skipping pairs', () => {
    const many = (island: number, n: number) => Array.from({ length: n }, (_, i) => node({ slug: `s${island}-${i}`, island }))
    const { islands } = spotlightOptions([...many(0, 6), ...many(1, 9), ...many(2, 2), ...many(-1, 4)], new Map())
    expect(islands.map((o) => [o.key, o.count])).toEqual([['1', 9], ['0', 6], ['-1', 4]])
  })
})
