import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'
import { useStableGraph } from './graph-view'

/**
 * Every poll refreshes the page and hands the map a new object with the same
 * content. The scene is rebuilt whenever that object changes, so a new object
 * per poll made the map zoom out and back in every few seconds.
 */
const graph = (title = 'Alpha'): KnowledgeGraph => ({
  nodes: [{ slug: 'alpha', title, project: 'CAIRN', entity: null, degree: 0, island: -1, x: 0, y: 0 }],
  entities: [],
  edges: [],
  missing: [],
  islands: [],
  width: 100,
  height: 100,
  isolatedFrom: 0,
  stats: { entries: 1, withReferences: 0, references: 0, resolved: 0, dangling: 0, isolated: 1, islands: 0 },
})

describe('the graph the map is built from', () => {
  it('stays the same object across a refresh that changed nothing, and follows one that did', () => {
    const seen: KnowledgeGraph[] = []
    const Probe = ({ g }: { g: KnowledgeGraph }) => {
      seen.push(useStableGraph(g))
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    const first = graph()
    act(() => root.render(<Probe g={first} />))
    act(() => root.render(<Probe g={graph()} />))
    expect(seen.at(-1)).toBe(first)

    const edited = graph('Alpha, edited')
    act(() => root.render(<Probe g={edited} />))
    expect(seen.at(-1)).toBe(edited)
    act(() => root.unmount())
  })
})
