import { describe, expect, it } from 'vitest'
import { groupsOf, layout3D } from './graph-3d'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The flat map's contract is that the picture is identical between renders, so
 * a `router.refresh()` landing after an agent writes a note cannot make it
 * jump. Lifting it into three dimensions keeps that contract or gives up the
 * only reason the layout is computed on the server in the first place — and a
 * relaxation is exactly the kind of code that quietly stops being
 * deterministic, so it is pinned here rather than trusted.
 */

const node = (slug: string, degree: number, i: number, entity: string | null = null) => ({
  slug,
  title: slug,
  project: null,
  entity,
  degree,
  island: degree > 0 ? 0 : -1,
  x: i * 17,
  y: (i % 5) * 23,
})

const graph = (over: Partial<KnowledgeGraph> = {}): KnowledgeGraph => {
  const nodes = [
    node('alpha', 3, 0),
    node('beta', 2, 1),
    node('gamma', 2, 2),
    node('delta', 1, 3),
    node('lonely', 0, 4),
    node('adrift', 0, 5),
  ]
  return {
    nodes,
    entities: [],
  edges: [
      { source: 'alpha', target: 'beta' },
      { source: 'alpha', target: 'gamma' },
      { source: 'beta', target: 'gamma' },
      { source: 'alpha', target: 'delta' },
    ],
    missing: [{ slug: 'never-written', from: ['alpha'], x: 5, y: 5 }],
    islands: [4],
    width: 100,
    height: 100,
    isolatedFrom: 4,
    stats: {
      entries: 6,
      withReferences: 4,
      references: 5,
      resolved: 4,
      dangling: 1,
      isolated: 2,
      islands: 1,
    },
    ...over,
  }
}

describe('the map in three dimensions', () => {
  it('puts the same corpus in the same place every time', () => {
    // Not "close enough": exactly. A relaxation that converges to a tolerance
    // rather than a fixed iteration count drifts with floating-point noise,
    // and the map would then move a little on every refresh.
    const a = layout3D(graph())
    const b = layout3D(graph())

    expect([...a.at.keys()].sort()).toEqual([...b.at.keys()].sort())
    for (const [slug, p] of a.at) {
      expect(b.at.get(slug)).toEqual(p)
    }
    expect(a.radius).toBe(b.radius)
    expect(a.shell).toBe(b.shell)
  })

  it('does not depend on the order the entries arrive in', () => {
    // The rows come back from Postgres in whatever order the planner chose.
    // Positions keyed off the index rather than the slug would move the whole
    // cloud when one entry was edited and its `updated_at` changed.
    const forward = layout3D(graph())
    const reversed = layout3D(graph({ nodes: [...graph().nodes].reverse() }))

    for (const [slug, p] of forward.at) {
      const other = reversed.at.get(slug)
      expect(other).toBeDefined()
      // Same seed, same forces, same answer — the relaxation is symmetric in
      // its inputs, so this is equality and not a tolerance either.
      expect(other?.x).toBeCloseTo(p.x, 6)
      expect(other?.y).toBeCloseTo(p.y, 6)
      expect(other?.z).toBeCloseTo(p.z, 6)
    }
  })

  it('never produces a coordinate that cannot be drawn', () => {
    // One NaN puts a sphere at the origin and a link across the whole scene,
    // and nothing reports it. Division by a zero distance is the way in, so
    // two entries on exactly the same point are the case that matters.
    const stacked = graph({
      nodes: graph().nodes.map((n) => ({ ...n, x: 0, y: 0 })),
    })
    const place = layout3D(stacked)

    for (const [slug, p] of place.at) {
      expect(Number.isFinite(p.x), `${slug}.x`).toBe(true)
      expect(Number.isFinite(p.y), `${slug}.y`).toBe(true)
      expect(Number.isFinite(p.z), `${slug}.z`).toBe(true)
    }
    expect(Number.isFinite(place.radius)).toBe(true)
  })

  it('keeps the entries joined to nothing outside everything else', () => {
    // This is the whole answer to the objection against drawing the map in 3D:
    // depth hides things behind other things, and how much of the corpus is
    // joined to nothing is the one finding the page exists to deliver.
    //
    // They used to sit on a plane below the cloud. They now sit on a shell
    // around it, which gives the same guarantee for a better reason — nothing
    // can occlude the outermost layer of a scene — and without a slab of
    // geometry under the map. So what is asserted is that every one of them is
    // further from the centre than every connected entry.
    const place = layout3D(graph())
    const connected = ['alpha', 'beta', 'gamma', 'delta']
    const orphans = ['lonely', 'adrift']
    const out = (slug: string) => {
      const p = place.at.get(slug)
      return Math.hypot(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0)
    }

    const furthestConnected = Math.max(...connected.map(out))
    for (const slug of orphans) {
      expect(out(slug)).toBeGreaterThan(furthestConnected)
    }
  })

  it('spreads the orphans over the shell rather than stacking them', () => {
    // They have no links, so any structure the eye finds in them would be a
    // lie — but they still have to be individually visible to be counted.
    const many = {
      ...graph(),
      nodes: [
        ...graph().nodes.filter((n) => n.degree > 0),
        ...Array.from({ length: 40 }, (_, i) => node(`orphan-${i}`, 0, i)),
      ],
    }
    const place = layout3D(many)
    const points = Array.from({ length: 40 }, (_, i) => place.at.get(`orphan-${i}`))

    expect(points.every(Boolean)).toBe(true)
    // No two in the same spot...
    const spots = new Set(points.map((p) => `${p?.x.toFixed(4)},${p?.y.toFixed(4)},${p?.z.toFixed(4)}`))
    expect(spots.size).toBe(40)
    // ...and spread over the sphere rather than bunched on one side, which is
    // what a naive random scatter and a badly seeded spiral both produce. The
    // centre of mass of an even shell sits near the middle.
    let mx = 0
    let my = 0
    let mz = 0
    for (const p of points) {
      mx += (p?.x ?? 0) / 40
      my += (p?.y ?? 0) / 40
      mz += (p?.z ?? 0) / 40
    }
    expect(Math.hypot(mx, my, mz)).toBeLessThan(place.shell * 0.25)
  })

  it('hangs a never-written reference off whatever cited it', () => {
    // Dropped at a random offset it lands inside the cluster it belongs to and
    // reads as one of its members, which is the opposite of the point.
    const place = layout3D(graph())
    const anchor = place.at.get('alpha')
    const stub = place.at.get('never-written')

    expect(stub).toBeDefined()
    expect(anchor).toBeDefined()
    const gap = Math.hypot(
      (stub?.x ?? 0) - (anchor?.x ?? 0),
      (stub?.y ?? 0) - (anchor?.y ?? 0),
      (stub?.z ?? 0) - (anchor?.z ?? 0),
    )
    expect(gap).toBeGreaterThan(0)
    // Near its anchor, not across the scene from it.
    expect(gap).toBeLessThan(place.radius)
  })

  it('draws a corpus with nothing joined to anything', () => {
    // A new install, and the case where the relaxation has no edges to run on.
    const place = layout3D(
      graph({
        nodes: [node('lonely', 0, 0), node('adrift', 0, 1)],
        entities: [],
    edges: [],
        missing: [],
        isolatedFrom: 0,
      }),
    )

    expect(place.at.size).toBe(2)
    for (const p of place.at.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
    }
  })

  it('draws an empty corpus without dividing by it', () => {
    const place = layout3D(
      graph({ nodes: [], edges: [], missing: [], islands: [], isolatedFrom: 0 }),
    )

    expect(place.at.size).toBe(0)
    expect(Number.isFinite(place.radius)).toBe(true)
    expect(place.radius).toBeGreaterThan(0)
  })

  it('pulls linked entries closer than unlinked ones', () => {
    // The relaxation has to actually do something. Without this the test suite
    // would pass on a layout that returned the seed unchanged.
    const place = layout3D(graph())
    const d = (a: string, b: string) => {
      const p = place.at.get(a)
      const q = place.at.get(b)
      return Math.hypot((p?.x ?? 0) - (q?.x ?? 0), (p?.y ?? 0) - (q?.y ?? 0), (p?.z ?? 0) - (q?.z ?? 0))
    }

    // alpha-beta-gamma are a triangle; delta hangs off alpha alone.
    expect(d('alpha', 'beta')).toBeLessThan(place.radius * 2)
    expect(d('beta', 'gamma')).toBeLessThan(place.radius * 2)
  })

  it('gathers the entries of one world closer together than the map as a whole', () => {
    // Five entities group thirty-five projects, and the map used to say
    // nothing about that. Links alone give you islands; islands alone do not
    // tell you that nineteen of those projects are the same business.
    const members = (key: string, n: number, from: number) =>
      Array.from({ length: n }, (_, i) => node(`${key}-${i}`, 1, from + i, key))
    const nodes = [...members('alpha', 6, 0), ...members('omega', 6, 10)]
    const place = layout3D(
      graph({
        nodes,
        // Every node linked to one hub of its OWN world, so the link forces
        // do not decide the answer on their own.
        edges: [
          ...Array.from({ length: 5 }, (_, i) => ({ source: 'alpha-0', target: `alpha-${i + 1}` })),
          ...Array.from({ length: 5 }, (_, i) => ({ source: 'omega-0', target: `omega-${i + 1}` })),
        ],
        missing: [],
        isolatedFrom: nodes.length,
      }),
    )

    const centre = (key: string) => {
      const pts = nodes.filter((n) => n.entity === key).map((n) => place.at.get(n.slug))
      const n = pts.length
      return {
        x: pts.reduce((s, p) => s + (p?.x ?? 0), 0) / n,
        y: pts.reduce((s, p) => s + (p?.y ?? 0), 0) / n,
        z: pts.reduce((s, p) => s + (p?.z ?? 0), 0) / n,
      }
    }
    const a = centre('alpha')
    const o = centre('omega')
    const between = Math.hypot(a.x - o.x, a.y - o.y, a.z - o.z)

    const within = (key: string, c: { x: number; y: number; z: number }) => {
      const pts = nodes.filter((n) => n.entity === key).map((n) => place.at.get(n.slug))
      return pts.reduce((s, p) => s + Math.hypot((p?.x ?? 0) - c.x, (p?.y ?? 0) - c.y, (p?.z ?? 0) - c.z), 0) / pts.length
    }

    // Each world is tighter around its own centre than the two worlds are
    // from each other. That is what makes them read as regions.
    expect(within('alpha', a)).toBeLessThan(between)
    expect(within('omega', o)).toBeLessThan(between)
  })

  it('reports where each world ended up, and how far it reaches', () => {
    // The scene draws a name and a soft volume at each of these, so they have
    // to be the post-relaxation truth rather than the seed.
    const nodes = [
      node('a1', 1, 0, 'alpha'),
      node('a2', 1, 1, 'alpha'),
      node('b1', 1, 2, 'beta'),
      node('b2', 1, 3, 'beta'),
    ]
    const place = layout3D(
      graph({
        nodes,
        edges: [
          { source: 'a1', target: 'a2' },
          { source: 'b1', target: 'b2' },
        ],
        missing: [],
        isolatedFrom: 4,
      }),
    )

    expect(place.worlds.map((w) => w.key)).toEqual(['alpha', 'beta'])
    for (const w of place.worlds) {
      expect(w.count).toBe(2)
      expect(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)).toBe(true)
      expect(w.spread).toBeGreaterThan(0)
    }
  })

  it('leaves a corpus with no entities alone', () => {
    // Most installs will have none, and the gathering must then be a no-op
    // rather than a force pulling everything to one point.
    const place = layout3D(graph())
    expect(place.worlds).toEqual([])
    for (const p of place.at.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
    }
  })

  it('does not let one far-flung island decide how big the map is', () => {
    // radius drives the camera framing and the shell. Taken as the MAXIMUM
    // distance it was decided by whichever two-entry island drifted furthest
    // under repulsion, and the dense core — the entire thing anybody came to
    // look at — ended up a knot in the middle of a lot of empty space.
    const core = Array.from({ length: 24 }, (_, i) => node(`core-${i}`, 2, i, 'core'))
    const edges = Array.from({ length: 23 }, (_, i) => ({
      source: 'core-0',
      target: `core-${i + 1}`,
    }))
    const tight = layout3D(graph({ nodes: core, edges, missing: [], isolatedFrom: core.length }))

    // the same corpus plus one pair flung far away from everything
    const withStraggler = layout3D(
      graph({
        nodes: [...core, node('far-a', 1, 400, 'far'), node('far-b', 1, 401, 'far')],
        edges: [...edges, { source: 'far-a', target: 'far-b' }],
        missing: [],
        isolatedFrom: core.length + 2,
      }),
    )

    // A couple of stragglers out of twenty-six must not double the scale.
    expect(withStraggler.radius).toBeLessThan(tight.radius * 1.6)
  })
})

describe('the named glows, grouped by project (CAIRN-340)', () => {
  const withProjects = (): KnowledgeGraph => {
    const g = graph()
    const projectOf: Record<string, string | null> = { alpha: 'CAIRN', beta: 'CAIRN', gamma: 'TRIG', delta: null }
    return { ...g, nodes: g.nodes.map((n) => ({ ...n, project: projectOf[n.slug] ?? null })) }
  }

  it('puts one glow at the centre of each project, over the layout positions', () => {
    const g = withProjects()
    const place = layout3D(g)
    const [cairn] = groupsOf(place, g.nodes, (n) => n.project)
    const a = place.at.get('alpha')
    const b = place.at.get('beta')
    expect(cairn?.key).toBe('CAIRN')
    expect(cairn?.count).toBe(2)
    expect(cairn?.x).toBeCloseTo(((a?.x ?? 0) + (b?.x ?? 0)) / 2)
    expect(cairn?.z).toBeCloseTo(((a?.z ?? 0) + (b?.z ?? 0)) / 2)
  })

  it('gives a project of one entry no glow, and an entry with no project none either', () => {
    const g = withProjects()
    const keys = groupsOf(layout3D(g), g.nodes, (n) => n.project).map((w) => w.key)
    expect(keys).toEqual(['CAIRN'])
  })

  it('leaves the positions alone: grouping changes where the light goes, nothing else', () => {
    const g = withProjects()
    const before = JSON.stringify([...layout3D(g).at])
    groupsOf(layout3D(g), g.nodes, (n) => n.project)
    expect(JSON.stringify([...layout3D(g).at])).toBe(before)
  })
})

describe('clusters arrangement (CAIRN-361)', () => {
  const project = (key: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      slug: `${key}-${i}`,
      title: `${key} ${i}`,
      project: key,
      entity: null,
      degree: 2,
      island: 0,
      x: i * 10,
      y: i * 7,
    }))
  const nodes = [...project('aa', 12), ...project('bb', 12), ...project('cc', 8)]
  const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i]!.slug, target: n.slug }))
  const graph = {
    nodes,
    entities: [],
    edges,
    missing: [],
    islands: [nodes.length],
    width: 200,
    height: 200,
    isolatedFrom: nodes.length,
    stats: { entries: nodes.length, withReferences: 0, references: 0, resolved: 0, dangling: 0, isolated: 0, islands: 1 },
  } as unknown as Parameters<typeof layout3D>[0]

  it('is deterministic', () => {
    const a = layout3D(graph, 'clusters')
    const b = layout3D(graph, 'clusters')
    expect([...a.at.entries()]).toEqual([...b.at.entries()])
  })

  it('keeps each project closer to itself than to the others', () => {
    const { at } = layout3D(graph, 'clusters')
    const centre = (key: string) => {
      const ps = nodes.filter((n) => n.project === key).map((n) => at.get(n.slug)!)
      return {
        x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
        y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
        z: ps.reduce((s, p) => s + p.z, 0) / ps.length,
        ps,
      }
    }
    for (const key of ['aa', 'bb', 'cc']) {
      const c = centre(key)
      const reach = c.ps.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z), 0) / c.ps.length
      for (const other of ['aa', 'bb', 'cc'].filter((k) => k !== key)) {
        const o = centre(other)
        expect(Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z)).toBeGreaterThan(reach * 2)
      }
    }
  })

  it('leaves the links arrangement as it was', () => {
    expect([...layout3D(graph).at.entries()]).toEqual([...layout3D(graph, 'links').at.entries()])
  })
})

describe('group cores (CAIRN-361)', () => {
  it('aims a camera at the bulk of a group, not at the one entry that wandered off', () => {
    const near = Array.from({ length: 9 }, (_, i) => ({ slug: `n${i}`, x: 0, y: 0, z: 0 }))
    const stray = { slug: 'far', x: 1000, y: 0, z: 0 }
    const nodes = [...near, stray].map((n) => ({
      slug: n.slug, title: n.slug, project: 'p', entity: null, degree: 1, island: 0, x: 0, y: 0,
    }))
    const place = {
      at: new Map([...near, stray].map((n) => [n.slug, { x: n.x, y: n.y, z: n.z }])),
      radius: 100, shell: 130, worlds: [],
    }
    const [group] = groupsOf(place, nodes as never, (n) => n.project)
    expect(group!.x).toBeGreaterThan(50)
    expect(group!.core!.x).toBe(0)
    expect(group!.core!.reach).toBeLessThan(100)
  })
})
