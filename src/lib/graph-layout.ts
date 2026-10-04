/**
 * Where to put each node, worked out on the server and settled before anything
 * is drawn.
 *
 * Every view in this app re-renders through `router.refresh()` when the stream
 * says something changed. A layout computed in the browser would therefore
 * reshuffle the whole map under the reader each time an agent wrote a note —
 * so this is a pure function of the graph, with no randomness anywhere: the
 * same corpus always lands in the same shape, and a refresh that changes
 * nothing moves nothing.
 *
 * It is also why the simulation runs per component rather than over everything
 * at once. Laying out nineteen islands in one field lets the repulsion between
 * them decide the picture, and they drift into an even scatter that hides the
 * very thing worth seeing. Laid out separately and then packed, an island
 * looks like an island.
 */

export type Edge = { source: string; target: string }
export type Placed = { id: string; x: number; y: number }

/** Deterministic, and the same hash `projectColor` uses. Never Math.random. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

/**
 * Connected components, largest first.
 *
 * The ordering matters to the reader rather than to the algorithm: the giant
 * component is the corpus, and everything after it is how far the corpus fell
 * short of being one.
 */
export const components = (ids: readonly string[], edges: readonly Edge[]): string[][] => {
  const adjacent = new Map<string, string[]>()
  for (const id of ids) adjacent.set(id, [])
  for (const { source, target } of edges) {
    if (source === target) continue
    adjacent.get(source)?.push(target)
    adjacent.get(target)?.push(source)
  }

  const seen = new Set<string>()
  const found: string[][] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    const group: string[] = []
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      group.push(id)
      for (const next of adjacent.get(id) ?? []) if (!seen.has(next)) stack.push(next)
    }
    found.push(group.sort())
  }

  // Size first, then by first member, so two islands of equal size keep a
  // stable order between renders.
  return found.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''))
}

/**
 * Fruchterman-Reingold, seeded from the hash of each id rather than at random.
 *
 * Repulsion between every pair, attraction along every edge, and a temperature
 * that cools so late passes refine instead of throwing nodes across the
 * canvas. A small component settles in far fewer passes than a large one, so
 * the pass count follows the size.
 */
const simulate = (ids: readonly string[], edges: readonly Edge[], size: number): Placed[] => {
  const n = ids.length
  if (n === 1) return [{ id: ids[0] as string, x: 0, y: 0 }]

  const k = size / Math.sqrt(n)
  const index = new Map(ids.map((id, i) => [id, i]))
  const x = new Float64Array(n)
  const y = new Float64Array(n)

  // A ring, spread by hash. Starting every node at one point makes the first
  // pass explosive; starting them on a perfect circle makes the result look
  // like a circle.
  ids.forEach((id, i) => {
    const h = hash(id)
    const angle = ((h % 3600) / 3600) * Math.PI * 2
    const radius = (0.35 + ((h >>> 12) % 1000) / 1538) * size * 0.5
    x[i] = Math.cos(angle) * radius
    y[i] = Math.sin(angle) * radius
  })

  const links: [number, number][] = []
  for (const { source, target } of edges) {
    const a = index.get(source)
    const b = index.get(target)
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b])
  }

  /* Sorted because the force loop below SUMS over this array, and floating
   * point addition is not associative: the same graph handed over in a
   * different edge order settles somewhere slightly different. The node path
   * is already protected — components() sorts — but the link list never was,
   * and knowledge-graph.ts builds `edges` by iterating rows whose order its
   * own comment calls "not stable across an update or a vacuum". The symptom
   * is a map that quietly rearranges after an unrelated write, which reads as
   * the map being organic rather than as a bug, which is why it survived.
   * Found porting this layout elsewhere, where the edges come from Postgres
   * and the drift was obvious. */
  links.sort((p, q) => p[0] - q[0] || p[1] - q[1])

  const passes = Math.min(400, Math.max(120, Math.round(3000 / Math.sqrt(n))))
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)

  for (let pass = 0; pass < passes; pass += 1) {
    dx.fill(0)
    dy.fill(0)

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ox = (x[i] as number) - (x[j] as number)
        let oy = (y[i] as number) - (y[j] as number)
        let d2 = ox * ox + oy * oy
        if (d2 < 0.01) {
          // Two nodes exactly on top of each other have no direction to push
          // apart in. Nudge by index, so the tie breaks the same way each run.
          ox = ((i % 7) - 3) * 0.1 + 0.05
          oy = ((j % 7) - 3) * 0.1 + 0.05
          d2 = ox * ox + oy * oy
        }
        const force = (k * k) / d2
        dx[i] = (dx[i] as number) + ox * force
        dy[i] = (dy[i] as number) + oy * force
        dx[j] = (dx[j] as number) - ox * force
        dy[j] = (dy[j] as number) - oy * force
      }
    }

    for (const [a, b] of links) {
      const ox = (x[a] as number) - (x[b] as number)
      const oy = (y[a] as number) - (y[b] as number)
      const d = Math.sqrt(ox * ox + oy * oy) || 0.01
      const force = d / k
      dx[a] = (dx[a] as number) - ox * force
      dy[a] = (dy[a] as number) - oy * force
      dx[b] = (dx[b] as number) + ox * force
      dy[b] = (dy[b] as number) + oy * force
    }

    // Cooling, and a step cap, so no single pass can fling a node off the map.
    const temperature = size * 0.1 * (1 - pass / passes) ** 1.5 + 0.5
    for (let i = 0; i < n; i += 1) {
      const d = Math.sqrt((dx[i] as number) ** 2 + (dy[i] as number) ** 2) || 1
      const step = Math.min(d, temperature)
      x[i] = (x[i] as number) + ((dx[i] as number) / d) * step
      y[i] = (y[i] as number) + ((dy[i] as number) / d) * step
    }
  }

  return ids.map((id, i) => ({ id, x: x[i] as number, y: y[i] as number }))
}

/**
 * Move a group to the origin and scale it to a comparable density.
 *
 * The simulation's `size` is a force constant, not a boundary: a long chain
 * spreads far past it while a tight cluster never reaches it. Left alone, one
 * island ends up ten times the scale of another and the packing cannot be
 * predicted — which showed up as a map three and a half thousand wide and nine
 * and a half thousand tall, most of it empty.
 *
 * So each island is scaled to roughly the same room per node. A dense island
 * then looks dense, which is the true thing about it, rather than merely large.
 */
const normalise = (
  placed: Placed[],
  spacing: number,
): { placed: Placed[]; width: number; height: number } => {
  const xs = placed.map((p) => p.x)
  const ys = placed.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.max(...xs) - minX
  const height = Math.max(...ys) - minY

  const wanted = spacing * Math.sqrt(placed.length)
  const longest = Math.max(width, height)
  const scale = longest > 0 ? Math.min(2.5, Math.max(0.25, wanted / longest)) : 1

  return {
    placed: placed.map((p) => ({ ...p, x: (p.x - minX) * scale, y: (p.y - minY) * scale })),
    width: width * scale,
    height: height * scale,
  }
}

export type Layout = {
  placed: Placed[]
  width: number
  height: number
  /** Index in `placed` where the connected part ends and the rest begins. */
  isolatedFrom: number
}

/**
 * Lay out the connected islands, then the nodes joined to nothing.
 *
 * The isolated ones get a grid rather than a simulation, and that is a
 * decision rather than a shortcut: a node with no edges has nothing to be
 * placed *by*, so a force layout leaves it wherever the repulsion happens to
 * push it, and a hundred of them read as fog around the picture. In rows they
 * read as what they are — a count.
 */
export const layoutGraph = (
  ids: readonly string[],
  edges: readonly Edge[],
  options: {
    width?: number
    aspect?: number
    gap?: number
    spacing?: number
    isolatedColumns?: number
    isolatedGap?: number
  } = {},
): Layout => {
  const gap = options.gap ?? 58
  /** Room per node inside an island, which sets every island's scale. */
  const spacing = options.spacing ?? 62
  /** The shape of the frame this will be drawn in, so it fills it. */
  const aspect = options.aspect ?? 16 / 9
  const isolatedGap = options.isolatedGap ?? 34

  const groups = components(ids, edges)
  const connected = groups.filter((group) => group.length > 1)
  const isolated = groups.filter((group) => group.length === 1).flat()

  // Each island is settled once. Packing them is then rearranging boxes, which
  // costs nothing — so the shelf width can be chosen by trying several and
  // keeping whichever comes out closest to the shape of the frame.
  const blocks = connected.map((group) => {
    const members = new Set(group)
    const within = edges.filter((e) => members.has(e.source) && members.has(e.target))
    // An island is drawn at a size that follows its weight, so the giant
    // component reads as the centre of the corpus rather than as one blob
    // among nineteen equals.
    const box = Math.max(180, Math.sqrt(group.length) * 105)
    return normalise(simulate(group, within, box), spacing)
  })

  /**
   * Skyline packing: each island drops into the lowest place it fits.
   *
   * Rows were simpler and left a hole the size of the largest island. A row is
   * as tall as its tallest member, so putting the 102-node component beside
   * three small ones wasted everything under those three — a quarter of the
   * map, empty, in the middle of the picture.
   */
  const pack = (shelfWidth: number): { placed: Placed[]; width: number; height: number } => {
    const step = 8
    const columns = Math.max(1, Math.ceil(shelfWidth / step))
    const skyline = new Float64Array(columns)
    const out: Placed[] = []
    let widest = 0
    let tallest = 0

    for (const block of blocks) {
      const span = Math.max(1, Math.ceil((block.width + gap) / step))
      let bestColumn = 0
      let bestTop = Infinity

      for (let start = 0; start + span <= Math.max(columns, span); start += 1) {
        let top = 0
        for (let c = start; c < Math.min(columns, start + span); c += 1) {
          top = Math.max(top, skyline[c] as number)
        }
        // Lowest wins; equally low, leftmost, so the result is stable and
        // reads left to right like everything else here.
        if (top < bestTop - 0.001) {
          bestTop = top
          bestColumn = start
        }
      }

      const left = bestColumn * step
      const top = bestTop === Infinity ? 0 : bestTop
      for (const p of block.placed) out.push({ id: p.id, x: p.x + left, y: p.y + top })

      for (let c = bestColumn; c < Math.min(columns, bestColumn + span); c += 1) {
        skyline[c] = top + block.height + gap
      }
      widest = Math.max(widest, left + block.width)
      tallest = Math.max(tallest, top + block.height)
    }

    return { placed: out, width: widest, height: tallest }
  }

  /**
   * Pick the shelf width whose result is shaped most like the frame.
   *
   * Computing it from the total area got this wrong by a factor of two: shelf
   * packing wastes whatever the tallest block in each row does not use, and how
   * much that is depends on the sizes, not on their sum. Measuring beats
   * estimating when the measurement is free.
   */
  const widest = Math.max(1, ...blocks.map((b) => b.width))
  const candidates =
    options.width !== undefined
      ? [options.width]
      : Array.from({ length: 12 }, (_, i) => widest * (1 + i * 0.45))

  /**
   * The band of unconnected nodes is part of the picture, so it is part of the
   * measurement.
   *
   * Judging the islands alone chose a width that was right for them and then
   * added three rows of orphans underneath, landing at 1.17 when it was aiming
   * for 1.78. What gets measured has to be what gets drawn.
   */
  const withBand = (packed: { width: number; height: number }): number => {
    if (isolated.length === 0) return packed.height
    const across = Math.max(8, Math.floor(Math.max(packed.width, 1) / isolatedGap))
    return packed.height + gap * 1.8 + Math.ceil(isolated.length / across) * isolatedGap
  }

  let best = pack(candidates[0] as number)
  let bestMiss = Infinity
  for (const candidate of candidates) {
    const attempt = pack(candidate)
    // Compared as logs, so twice too wide and half as wide are judged equally
    // wrong rather than the wide one always winning.
    const miss = Math.abs(
      Math.log((attempt.width || 1) / (withBand(attempt) || 1)) - Math.log(aspect),
    )
    if (miss < bestMiss) {
      bestMiss = miss
      best = attempt
    }
  }

  const placed = best.placed
  const width = Math.max(best.width, 1)
  const isolatedFrom = placed.length
  const isolatedTop = connected.length > 0 ? best.height + gap * 1.8 : 0

  /**
   * Span whatever the islands above ended up spanning, so the band reads as a
   * share of the corpus rather than as a footnote in one corner.
   *
   * With NO islands at all there is nothing to span, and taking the widest
   * placed node gave 0.5 — eight columns, and 377 entries stacked into a
   * 238-by-1598 ribbon that `preserveAspectRatio` then shrank to an unreadable
   * vertical strip. That is not an exotic case: it is a fresh install, where
   * entries exist and nobody has written a reference yet, and therefore the
   * first thing anybody sees.
   */
  const spanned = Math.max(...placed.map((p) => p.x), 0)
  const columns =
    options.isolatedColumns ??
    (spanned > isolatedGap
      ? Math.max(8, Math.floor(spanned / isolatedGap))
      : Math.max(8, Math.ceil(Math.sqrt(Math.max(1, isolated.length) * aspect))))

  isolated.forEach((id, i) => {
    placed.push({
      id,
      x: (i % columns) * isolatedGap,
      y: isolatedTop + Math.floor(i / columns) * isolatedGap,
    })
  })

  return {
    placed,
    width: Math.max(1, ...placed.map((p) => p.x)),
    height: Math.max(1, ...placed.map((p) => p.y)),
    isolatedFrom,
  }
}
