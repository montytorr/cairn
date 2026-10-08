import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * Where the map goes when it stops being flat.
 *
 * The 2D layout arrives from the server and is the contract everything else
 * relies on: identical between renders, so a `router.refresh()` landing after
 * an agent writes a note cannot make the picture jump. This keeps that
 * contract. There is no `Math.random` anywhere below, the relaxation runs a
 * fixed number of iterations rather than to a tolerance, and every seed comes
 * from the same slug hash the palette and the 2D layout already use. Same
 * corpus in, same cloud out, on every machine.
 *
 * The relaxation is worth the ~40ms it costs. Lifting the flat layout straight
 * up — x and y kept, z from a hash — gives you a picture that is technically
 * three-dimensional and reads as a flat map with jitter, because the structure
 * is still entirely in two of the axes. Letting the islands find their own
 * shape in all three is what makes the depth mean something: clusters become
 * volumes you can orbit rather than discs you are looking at edge-on.
 *
 * The entries joined to nothing do NOT take part. They sit on a sphere shell
 * AROUND the cloud, spread by a Fibonacci distribution. That is deliberate and
 * it is the whole answer to the objection against drawing this in 3D at all:
 * depth hides things behind other things, and the one thing this page exists
 * to show is how much of the corpus is joined to nothing.
 *
 * Nothing can occlude the outermost layer of a scene, so a shell gives the
 * same guarantee a floor did — countable from every angle the camera can
 * reach — without a slab of geometry sitting under the map. It also says the
 * right thing: unconnected matter on the periphery of the structure, rather
 * than sediment at the bottom of it.
 */

/** Deterministic, and the same hash the layout and the palette use. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

/** A hashed value in [0, 1), from an independent stream per axis. */
const unit = (key: string, salt: number): number => ((hash(key) ^ (salt * 0x9e3779b1)) >>> 0) / 4294967296

export type Point3 = { x: number; y: number; z: number }

export type Layout3D = {
  /** Connected entries, and the stubs for entries nobody wrote. */
  at: Map<string, Point3>
  /** Roughly the radius of the connected cloud, for framing the camera. */
  radius: number
  /** The sphere the joined-to-nothing sit on, outside everything else. */
  shell: number
  /**
   * Where each world ended up, and how big it is.
   *
   * The scene draws a name and a soft volume at each of these. Computed here
   * rather than there because it is the layout that knows where anything is,
   * and because a centroid taken after the relaxation is the honest answer to
   * "where is Dispofi" — not a guess made from the seed.
   */
  worlds: { key: string; x: number; y: number; z: number; spread: number; count: number }[]
}

/** How far apart the cloud wants to be, before anything is drawn in it. */
const SPREAD = 100

/**
 * Fixed, not "until it settles".
 *
 * A tolerance makes the result depend on floating-point noise and on how many
 * nodes happen to be in the corpus that day, which is exactly the kind of
 * thing that moves a map between two renders of the same data.
 */
const ITERATIONS = 90

/**
 * How the cloud is arranged (CAIRN-361).
 *
 * `links` lets the references decide, which is the honest picture of how the
 * corpus is wired and the unreadable one: projects share the middle and their
 * names and glows land on top of each other. `clusters` gives every project a
 * place of its own on a sphere and lets the links work inside it, so a project
 * reads as one constellation and a cross-project reference reads as an arc
 * between two of them.
 */
export type Arrange = 'clusters' | 'links'

/** Room a cluster needs, from how many entries it holds: volume goes as n, radius as n^(1/3). */
const roomFor = (count: number): number => 16 + 11 * Math.cbrt(count)

/**
 * Where each project with company sits, on a flattened sphere.
 *
 * Largest first and spread by a stride coprime to the count, so consecutive
 * (and therefore similar-sized) projects are never neighbours on the spiral:
 * the big ones end up evenly apart instead of crowding one side.
 */
const anchorsFor = (counts: Map<string, number>): Map<string, Point3> => {
  const keys = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key]) => key)
  const n = keys.length
  const out = new Map<string, Point3>()
  if (n === 0) return out
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  let stride = Math.max(1, Math.round(n * 0.618))
  while (gcd(stride, n) !== 1) stride += 1
  // Big clusters push the sphere out: the sphere's surface must hold their
  // combined cross-sections with air between them.
  const area = keys.reduce((sum, key) => sum + roomFor(counts.get(key) ?? 0) ** 2, 0)
  const radius = Math.max(SPREAD * 0.9, Math.sqrt(area) * 1.75)
  const golden = Math.PI * (3 - Math.sqrt(5))
  keys.forEach((key, rank) => {
    const slot = (rank * stride) % n
    const up = n === 1 ? 0 : 1 - (2 * (slot + 0.5)) / n
    const ring = Math.sqrt(Math.max(0, 1 - up * up))
    const a = slot * golden
    out.set(key, { x: Math.cos(a) * ring * radius, y: up * radius * 0.8, z: Math.sin(a) * ring * radius })
  })
  return out
}

export const layout3D = (graph: KnowledgeGraph, arrange: Arrange = 'links'): Layout3D => {
  /**
   * Sorted, and that is not cosmetic.
   *
   * The rows arrive in whatever order Postgres chose, which changes when an
   * entry is edited and its `updated_at` moves. Floating-point addition is not
   * associative, so summing the same forces in a different order gives a
   * slightly different answer — and "slightly" compounds over ninety
   * iterations into a visibly different cloud. Fixing the order fixes the
   * arithmetic, and the map stops depending on which row the planner happened
   * to return first.
   */
  const byName = (a: { slug: string }, b: { slug: string }) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  const connected = graph.nodes.filter((n) => n.degree > 0).sort(byName)
  const isolated = graph.nodes.filter((n) => n.degree === 0).sort(byName)
  const at = new Map<string, Point3>()

  const index = new Map(connected.map((n, i) => [n.slug, i]))
  const count = connected.length

  // Flat arrays rather than objects: this is the only hot loop on the page and
  // it runs 90 times over every pair.
  const px = new Float64Array(count)
  const py = new Float64Array(count)
  const pz = new Float64Array(count)
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)
  const fz = new Float64Array(count)

  // The flat layout's own extent, so the seed is scaled to the cloud rather
  // than to whatever coordinate space the server happened to use.
  const xs = connected.map((n) => n.x)
  const ys = connected.map((n) => n.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(1, Math.max(...xs) - minX)
  const spanY = Math.max(1, Math.max(...ys) - minY)

  const clustered = arrange === 'clusters'
  const projectCounts = new Map<string, number>()
  for (const n of connected) if (n.project) projectCounts.set(n.project, (projectCounts.get(n.project) ?? 0) + 1)
  const anchors = clustered ? anchorsFor(projectCounts) : new Map<string, Point3>()
  const home: (Point3 | undefined)[] = connected.map((n) => (n.project ? anchors.get(n.project) : undefined))

  for (let i = 0; i < count; i += 1) {
    const n = connected[i]
    if (!n) continue
    const anchor = home[i]
    if (anchor && n.project) {
      // Born inside its own cluster: the relaxation then tidies a cluster
      // instead of having to haul entries across the cloud to it.
      const room = roomFor(projectCounts.get(n.project) ?? 1)
      px[i] = anchor.x + (unit(n.slug, 1) - 0.5) * room
      py[i] = anchor.y + (unit(n.slug, 2) - 0.5) * room
      pz[i] = anchor.z + (unit(n.slug, 3) - 0.5) * room
      continue
    }
    // Seeded FROM the flat layout, not from nothing. The server has already
    // done the work of pulling islands apart; starting from a random cloud
    // throws that away and lets the relaxation find a different, equally valid
    // arrangement every time the corpus changes by one entry.
    px[i] = ((n.x - minX) / spanX - 0.5) * SPREAD * 2
    py[i] = ((n.y - minY) / spanY - 0.5) * SPREAD * 2
    pz[i] = (unit(n.slug, 1) - 0.5) * SPREAD * 1.2
  }

  // Edges as index pairs, resolved once rather than through the map 90 times.
  const ea: number[] = []
  const eb: number[] = []
  for (const { source, target } of graph.edges) {
    const a = index.get(source)
    const b = index.get(target)
    if (a === undefined || b === undefined) continue
    ea.push(a)
    eb.push(b)
  }

  /* Same reason as the 2D layout: the relaxation sums over these pairs and
   * float addition is not associative, so an unstable edge order moves the
   * scene when nothing changed. */
  const order = ea.map((_, i) => i).sort((i, j) => ea[i]! - ea[j]! || eb[i]! - eb[j]!)
  const sortedA = order.map((i) => ea[i]!)
  const sortedB = order.map((i) => eb[i]!)
  ea.length = 0
  eb.length = 0
  ea.push(...sortedA)
  eb.push(...sortedB)

  const repulsion = SPREAD * SPREAD * 0.9
  const rest = SPREAD * 0.22

  /**
   * Which world each node belongs to, as an index.
   *
   * Entries sharing an entity are pulled toward their own shared centre, on
   * top of whatever their links are doing. Links alone give you islands;
   * islands alone do not tell you that nineteen of the thirty-five projects
   * are the same business. The pull is deliberately weaker than the springs —
   * it should gather the worlds into regions, not drag two genuinely linked
   * entries apart to sit with their own kind.
   */
  const worldKeys = [...new Set(connected.map((n) => n.entity).filter((e): e is string => Boolean(e)))].sort()
  const worldOf = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i += 1) {
    const e = connected[i]?.entity
    if (e) worldOf[i] = worldKeys.indexOf(e)
  }
  const worldN = worldKeys.length
  const wx = new Float64Array(worldN)
  const wy = new Float64Array(worldN)
  const wz = new Float64Array(worldN)
  const wc = new Float64Array(worldN)
  const GATHER = 0.035

  // Skipped entirely when there is nothing to relax. A corpus where no entry
  // references another is not a broken corpus — it is a new install, and it
  // still has to draw. Returning early here instead left the orphans and the
  // never-written stubs unplaced, so the map came back empty.
  for (let step = 0; count > 0 && step < ITERATIONS; step += 1) {
    fx.fill(0)
    fy.fill(0)
    fz.fill(0)

    // Everything pushes everything else apart, which is what stops the
    // clusters collapsing into one another and gives the cloud its volume.
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = (px[i] as number) - (px[j] as number)
        let dy = (py[i] as number) - (py[j] as number)
        let dz = (pz[i] as number) - (pz[j] as number)
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 0.01) {
          // Two entries on exactly the same point have no direction to
          // separate along. Nudge them apart deterministically rather than
          // dividing by nothing.
          // Keyed off the slugs, not the indices: an index-keyed nudge is a
          // different nudge the moment the rows come back in another order.
          const pair = `${connected[i]?.slug ?? i}:${connected[j]?.slug ?? j}`
          dx = unit(pair, 2) - 0.5
          dy = unit(pair, 3) - 0.5
          dz = unit(pair, 4) - 0.5
          d2 = 0.01
        }
        // Inside a cluster the entries may sit closer than the cloud as a
        // whole would let them: the anchors keep the clusters apart.
        const same = clustered && connected[i]?.project && connected[i]?.project === connected[j]?.project
        const force = (repulsion * (same ? 0.35 : 1)) / d2
        const d = Math.sqrt(d2)
        const ux = (dx / d) * force
        const uy = (dy / d) * force
        const uz = (dz / d) * force
        fx[i] = (fx[i] as number) + ux
        fy[i] = (fy[i] as number) + uy
        fz[i] = (fz[i] as number) + uz
        fx[j] = (fx[j] as number) - ux
        fy[j] = (fy[j] as number) - uy
        fz[j] = (fz[j] as number) - uz
      }
    }

    // Each world gathers toward its own centre of mass, recomputed every
    // step so the regions form rather than being decided in advance.
    if (clustered) {
      for (let i = 0; i < count; i += 1) {
        const a = home[i]
        if (!a) continue
        const K = 0.35
        fx[i] = (fx[i] as number) + (a.x - (px[i] as number)) * K
        fy[i] = (fy[i] as number) + (a.y - (py[i] as number)) * K
        fz[i] = (fz[i] as number) + (a.z - (pz[i] as number)) * K
      }
    } else if (worldN > 0) {
      wx.fill(0); wy.fill(0); wz.fill(0); wc.fill(0)
      for (let i = 0; i < count; i += 1) {
        const w = worldOf[i] as number
        if (w < 0) continue
        wx[w] = (wx[w] as number) + (px[i] as number)
        wy[w] = (wy[w] as number) + (py[i] as number)
        wz[w] = (wz[w] as number) + (pz[i] as number)
        wc[w] = (wc[w] as number) + 1
      }
      for (let i = 0; i < count; i += 1) {
        const w = worldOf[i] as number
        if (w < 0 || (wc[w] as number) < 2) continue
        const n = wc[w] as number
        fx[i] = (fx[i] as number) + (((wx[w] as number) / n) - (px[i] as number)) * GATHER * repulsion * 0.0004
        fy[i] = (fy[i] as number) + (((wy[w] as number) / n) - (py[i] as number)) * GATHER * repulsion * 0.0004
        fz[i] = (fz[i] as number) + (((wz[w] as number) / n) - (pz[i] as number)) * GATHER * repulsion * 0.0004
      }
    }

    // And links pull their two ends together.
    for (let e = 0; e < ea.length; e += 1) {
      const i = ea[e] as number
      const j = eb[e] as number
      const dx = (px[j] as number) - (px[i] as number)
      const dy = (py[j] as number) - (py[i] as number)
      const dz = (pz[j] as number) - (pz[i] as number)
      const d = Math.hypot(dx, dy, dz) || 1
      const pull = (d - rest) * 0.06
      const ux = (dx / d) * pull
      const uy = (dy / d) * pull
      const uz = (dz / d) * pull
      fx[i] = (fx[i] as number) + ux
      fy[i] = (fy[i] as number) + uy
      fz[i] = (fz[i] as number) + uz
      fx[j] = (fx[j] as number) - ux
      fy[j] = (fy[j] as number) - uy
      fz[j] = (fz[j] as number) - uz
    }

    // Cooling, so the early steps move things a long way and the late ones
    // only tidy. Without it the last iteration is as violent as the first and
    // the result depends on where it happened to stop.
    const heat = 0.9 * (1 - step / ITERATIONS) ** 1.4 + 0.04
    for (let i = 0; i < count; i += 1) {
      // Pulled gently home, or the repulsion inflates the cloud without limit
      // and the islands drift off the far side of the camera.
      const gravity = clustered ? 0.002 : 0.012
      const vx = (fx[i] as number) * heat - (px[i] as number) * gravity
      const vy = (fy[i] as number) * heat - (py[i] as number) * gravity
      const vz = (fz[i] as number) * heat - (pz[i] as number) * gravity
      // Clamped: one very close pair produces an enormous force, and a node
      // thrown across the scene in a single step never comes back.
      const limit = SPREAD * 0.35
      const speed = Math.hypot(vx, vy, vz)
      const k = speed > limit ? limit / speed : 1
      px[i] = (px[i] as number) + vx * k
      py[i] = (py[i] as number) + vy * k
      pz[i] = (pz[i] as number) + vz * k
    }
  }

  /**
   * How big the cloud is, measured at the ninetieth percentile rather than at
   * the furthest node.
   *
   * The maximum is the wrong number and it showed: a handful of two-entry
   * islands drift a long way out under repulsion, and framing the camera on
   * the furthest of them left the dense core — which is the entire thing
   * anybody came to look at — occupying about a fifth of the screen. A
   * percentile ignores the stragglers and describes where the corpus actually
   * is. They are still drawn, and still reachable by scrolling out; they just
   * no longer get a vote on the framing.
   *
   * Same lesson the world `spread` above already learned by taking a mean
   * rather than a max: every cluster has one outlier, and letting it set the
   * scale makes the picture about the outlier.
   */
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const n = connected[i]
    if (!n) continue
    const p = { x: px[i] as number, y: py[i] as number, z: pz[i] as number }
    at.set(n.slug, p)
    out.push(Math.hypot(p.x, p.y, p.z))
  }
  out.sort((a, b) => a - b)
  const radius = Math.max(SPREAD, out[Math.floor(out.length * 0.9)] ?? SPREAD)

  /**
   * Where each world settled, and how far it reaches.
   *
   * `spread` is the mean distance of a world's members from their own centre,
   * which is what the scene sizes its volume and its name from. A maximum
   * would be dominated by the one outlier every cluster has.
   */
  const worlds: Layout3D['worlds'] = worldKeys.map((key, w) => {
    let sx = 0, sy = 0, sz = 0, n = 0
    for (let i = 0; i < count; i += 1) {
      if ((worldOf[i] as number) !== w) continue
      sx += px[i] as number; sy += py[i] as number; sz += pz[i] as number; n += 1
    }
    if (n === 0) return { key, x: 0, y: 0, z: 0, spread: SPREAD, count: 0 }
    const cx = sx / n, cy = sy / n, cz = sz / n
    let d = 0
    for (let i = 0; i < count; i += 1) {
      if ((worldOf[i] as number) !== w) continue
      d += Math.hypot((px[i] as number) - cx, (py[i] as number) - cy, (pz[i] as number) - cz)
    }
    return { key, x: cx, y: cy, z: cz, spread: Math.max(SPREAD * 0.2, d / n), count: n }
  })

  /**
   * Outside the corpus, which is what makes them impossible to hide.
   *
   * Close enough that the shell and the cloud frame together — pushed further
   * out, the camera has to pull back to include it and the graph shrinks to a
   * knot in the middle of a lot of empty space.
   */
  const shell = radius * 1.32

  /**
   * The entries joined to nothing, on a shell of their own.
   *
   * A Fibonacci sphere — the same golden-angle idea a sunflower head uses,
   * lifted onto a sphere — because it spaces points evenly at any count, with
   * no rows to line up and no poles to bunch at. They have no links, so any
   * structure the eye found in them would be a lie, and an even scatter is the
   * only honest arrangement.
   *
   * The radius is nudged per entry so the shell reads as a diffuse halo rather
   * than a hard glass sphere around the map, which would look like a container
   * and imply a boundary that is not there.
   */
  const golden = Math.PI * (3 - Math.sqrt(5))
  const howMany = Math.max(1, isolated.length)
  isolated.forEach((n, i) => {
    const up = 1 - (2 * (i + 0.5)) / howMany
    const ring = Math.sqrt(Math.max(0, 1 - up * up))
    const a = i * golden
    const r = shell * (0.9 + unit(n.slug, 15) * 0.24)
    at.set(n.slug, {
      x: Math.cos(a) * ring * r,
      // Flattened, because a true sphere around a cloud that is itself wider
      // than it is tall reads as a bubble rather than a halo.
      y: up * r * 0.72,
      z: Math.sin(a) * ring * r,
    })
  })

  /**
   * A reference to something nobody wrote, hung off whatever cited it.
   *
   * Pushed outward from the cloud's centre rather than dropped at a random
   * offset, so a stub never lands inside the cluster it belongs to and reads
   * as one of its members.
   */
  for (const gap of graph.missing) {
    const anchor = gap.from[0] ? at.get(gap.from[0]) : undefined
    if (!anchor) {
      at.set(gap.slug, {
        x: (unit(gap.slug, 5) - 0.5) * radius,
        y: (unit(gap.slug, 6) - 0.5) * radius,
        z: (unit(gap.slug, 7) - 0.5) * radius,
      })
      continue
    }
    const out = Math.hypot(anchor.x, anchor.y, anchor.z) || 1
    const reach = radius * 0.16
    at.set(gap.slug, {
      x: anchor.x + (anchor.x / out) * reach + (unit(gap.slug, 8) - 0.5) * reach,
      y: anchor.y + (anchor.y / out) * reach + (unit(gap.slug, 9) - 0.5) * reach,
      z: anchor.z + (anchor.z / out) * reach + (unit(gap.slug, 10) - 0.5) * reach,
    })
  }

  return { at, radius, shell, worlds }
}

/**
 * The named glows, for any way of grouping the entries.
 *
 * The scene drew one per entity, and an instance with one entity — Dispofi,
 * where it covers 25 of 33 projects — got a single glow around everything,
 * which says nothing (CAIRN-340). Grouped by project, each project's entries
 * get their own. Positions are the layout's, untouched: only where the light
 * goes changes. A group of one is not a region, so it gets no glow.
 */
export const groupsOf = (
  place: Layout3D,
  nodes: KnowledgeGraph['nodes'],
  keyOf: (node: KnowledgeGraph['nodes'][number]) => string | null,
  minimum = 2,
): Layout3D['worlds'] => {
  const members = new Map<string, { x: number; y: number; z: number }[]>()
  for (const node of nodes) {
    const key = keyOf(node)
    const p = place.at.get(node.slug)
    if (!key || !p) continue
    const list = members.get(key) ?? []
    list.push(p)
    members.set(key, list)
  }
  return [...members.entries()]
    .filter(([, ps]) => ps.length >= minimum)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, ps]) => {
      const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length
      const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length
      const cz = ps.reduce((s, p) => s + p.z, 0) / ps.length
      const d = ps.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy, p.z - cz), 0) / ps.length
      return { key, x: cx, y: cy, z: cz, spread: Math.max(SPREAD * 0.2, d), count: ps.length }
    })
}
