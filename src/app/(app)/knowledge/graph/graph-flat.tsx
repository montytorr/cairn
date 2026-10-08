'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/control'
import { projectColor } from '@/components/icons'
import { inSpotlight, type Spotlight } from '@/lib/graph-spotlight'
import { mapNow, nodeColour, type ColourBy } from '@/lib/graph-colour'
import type { GraphNode, KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The map, drawn as inline SVG.
 *
 * SVG rather than canvas, and that is the load-bearing choice. Colour here is
 * `var(--border)`, `var(--danger)` and the project palette, so the light/dark
 * swap — a class flipped on `<html>` by next-themes, which notifies no
 * JavaScript at all — is a plain CSS repaint. A canvas would have to read the
 * custom properties back out with getComputedStyle and repaint the scene from
 * a MutationObserver on that class, which is a lot of machinery to end up
 * where a stylesheet already was.
 *
 * It was also why this was the ONLY renderer. The argument was that three
 * dimensions photograph well and read worse — depth hides exactly what this
 * page exists to show, how much of the corpus is joined to nothing, behind
 * whatever happens to be in front of it. There is now a WebGL scene in
 * `graph-scene.tsx` as well, and that argument is why it is a sibling rather
 * than a replacement: this file is what a browser without WebGL gets, what
 * the toggle goes back to, and still the view to reach for when the question
 * is "what is NOT joined to anything" rather than "what shape is this".
 * See that file's header for how it earns its place.
 *
 * Every position arrives as a prop and nothing is simulated in the browser, so
 * the picture cannot jump when `router.refresh()` lands after an agent writes
 * a note. The drift below moves nodes AROUND those fixed anchors; it never
 * changes them.
 */

/** Breathing room around the drawing, as a share of its longest side. */
const MARGIN = 0.04

/** Enough links to be worth naming without being asked. */
const LABEL_AT = 6

type Props = {
  graph: KnowledgeGraph
  focused: string | null
  setFocused: (slug: string | null) => void
  /** One project or world lit against the rest, or null for all of it. */
  spotlight: Spotlight
  /** What the dots' colour says; project unless somebody asked for another question. */
  colourBy?: ColourBy
}

/** Deterministic, and the same hash the layout and the palette use. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

/** A radius that makes a hub look like one. */
const radiusOf = (degree: number): number =>
  degree === 0 ? 2.6 : 3.4 + Math.min(9, Math.sqrt(degree) * 2.6)

/**
 * A link, bowed rather than ruled.
 *
 * Straight lines between hundreds of nodes cross into a hatch pattern and
 * every one of them reads the same. A consistent bow — always the same side,
 * always the same fraction of the span — separates the crossings and gives
 * the web the look of something grown rather than drawn.
 */
const curve = (ax: number, ay: number, bx: number, by: number): string => {
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy) || 1
  const bow = Math.min(18, length * 0.12)
  return `M${ax} ${ay} Q${mx - (dy / length) * bow} ${my + (dx / length) * bow} ${bx} ${by}`
}

/** Everything the drawn layers need, and nothing that changes on a wheel tick. */
type LayerProps = {
  graph: KnowledgeGraph
  at: Map<string, GraphNode>
  neighbours: Map<string, Set<string>>
  focused: string | null
  /** Passed through the memo boundary so a change to it redraws the layers. */
  spotlight: Spotlight
  onFocus: (slug: string | null) => void
}

/**
 * Hover wins over the spotlight.
 *
 * A spotlight is the resting state — "I am looking at Dispofi" — and pointing
 * at a node is a question asked on top of it. If the two fought, hovering a
 * neighbour that happens to sit outside the lit project would dim the very
 * thing under the cursor.
 */
const isLit = (
  focused: string | null,
  neighbours: LayerProps['neighbours'],
  slug: string,
  spotlight: Spotlight = null,
  at?: Map<string, GraphNode>,
) => {
  if (focused !== null) return focused === slug || (neighbours.get(focused)?.has(slug) ?? false)
  if (!spotlight) return true
  const node = at?.get(slug)
  return node ? inSpotlight(node, spotlight) : false
}

/**
 * The three drawn layers, memoised.
 *
 * None of this depends on the zoom or the pan — those are one transform on the
 * group above. Left inline, a wheel tick re-diffed roughly 2,500 SVG elements,
 * at trackpad rates of fifty to a hundred a second, and a hover did the same.
 * Split out, a zoom re-renders one attribute.
 */
const EdgeLayer = memo(function EdgeLayer({ graph, at, neighbours, focused, spotlight }: LayerProps) {
  return (
    <g stroke="var(--fg-subtle)" strokeLinecap="round" fill="none">
      {graph.edges.map(({ source, target }) => {
        const a = at.get(source)
        const b = at.get(target)
        if (!a || !b) return null
        const on =
          isLit(focused, neighbours, source, spotlight, at) &&
          isLit(focused, neighbours, target, spotlight, at)
        const path = curve(a.x, a.y, b.x, b.y)
        return (
          <g key={`${source}-${target}`}>
            <path
              d={path}
              strokeWidth={on && focused ? 1.5 : 1}
              opacity={on ? (focused ? 0.9 : 0.34) : 0.09}
            />
            {/* Light travelling the links of whatever is being looked at.
                Only those links: a pulse on all 450 is a repaint every frame,
                and a map that shimmers everywhere says nothing about
                anywhere. */}
            {focused && on && (
              <path
                className="graph-beam"
                d={path}
                stroke={a.project ? projectColor(a.project) : 'var(--accent)'}
                strokeWidth={1.8}
              />
            )}
          </g>
        )
      })}
    </g>
  )
})

/**
 * A reference to something nobody wrote, drawn where it was made.
 *
 * Dashed and hollow, because the whole point is that it is not there —
 * dropping it is what kept 31 of these invisible.
 */
const MissingLayer = memo(function MissingLayer({
  graph,
  at,
  neighbours,
  focused,
  spotlight,
  onFocus,
}: LayerProps) {
  return (
    <g>
      {graph.missing.map((gap) => {
        const anchor = at.get(gap.from[0] as string)
        const on = isLit(focused, neighbours, gap.slug, spotlight, at)
        return (
          <g key={gap.slug} opacity={on ? 1 : 0.12}>
            {anchor && (
              <path
                d={curve(anchor.x, anchor.y, gap.x, gap.y)}
                fill="none"
                stroke="var(--danger)"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.55}
              />
            )}
            <circle
              cx={gap.x}
              cy={gap.y}
              r={3.6}
              fill="none"
              stroke="var(--danger)"
              strokeWidth={1.2}
              strokeDasharray="2.5 2"
              onPointerEnter={() => onFocus(gap.slug)}
              onPointerLeave={() => onFocus(null)}
              className="cursor-help"
            />
          </g>
        )
      })}
    </g>
  )
})

/**
 * The nodes, and the light around them.
 *
 * The halo is drawn unconditionally and dimmed to nothing, rather than mounted
 * only when lit: focusing one node used to unmount roughly 370 circles and
 * remount them on leave, which is a great deal of work to make a picture
 * quieter.
 *
 * Drift is skipped for anything joined to nothing. Those sit in a grid at the
 * foot of the map and read as a count, so there is nothing for breathing to
 * say about them — and it takes a third of the animated groups off a raster
 * loop that never stops while the page is open.
 */
const NodeLayer = memo(function NodeLayer({
  graph,
  at,
  neighbours,
  focused,
  spotlight,
  onFocus,
  onOpen,
  colourBy = 'project',
}: LayerProps & { onOpen: (slug: string, event: React.MouseEvent) => void; colourBy?: ColourBy }) {
  const now = mapNow()
  return (
    <>
      {graph.nodes.map((n) => {
        const on = isLit(focused, neighbours, n.slug, spotlight, at)
        const r = radiusOf(n.degree)
        const colour = nodeColour(n, colourBy, now) ?? 'var(--fg-muted)'
        const seed = hash(n.slug)
        return (
          <g
            key={n.slug}
            className={n.degree === 0 ? 'graph-node graph-still' : 'graph-node'}
            style={
              {
                '--delay': `${-(seed % 9000) / 1000}s`,
                '--drift': `${6 + (seed % 5)}s`,
                '--rise': `${((seed % 700) / 1000).toFixed(2)}s`,
              } as React.CSSProperties
            }
          >
            <circle
              cx={n.x}
              cy={n.y}
              r={r * (n.project ? 3.2 : 2.5)}
              fill={n.project ? 'url(#halo)' : 'url(#halo-global)'}
              color={colour}
              opacity={on ? (n.degree === 0 ? 0.35 : focused ? 1 : 0.8) : 0}
              className="pointer-events-none"
            />
            <Link
              href={`/knowledge/${n.slug}`}
              // Every node is in the viewport at once, so the default viewport
              // prefetch schedules a request per entry on first paint — 377 of
              // them, each through the app layout.
              prefetch={false}
              // The map is not a navigation surface; the page says so. One tab
              // stop per entry would put several hundred unnamed, unstyled
              // stops between the breadcrumb and the legend, and a focusable
              // element inside role="img" is wrong anyway.
              tabIndex={-1}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={colour}
                stroke="var(--bg)"
                strokeWidth={n.degree === 0 ? 0.7 : 1.1}
                opacity={on ? (n.degree === 0 ? 0.6 : 1) : 0.16}
                onPointerEnter={() => onFocus(n.slug)}
                onPointerLeave={() => onFocus(null)}
                onClick={(event) => onOpen(n.slug, event)}
                className="cursor-pointer transition-opacity"
              />
            </Link>
          </g>
        )
      })}
    </>
  )
})

export const GraphFlat = ({ graph, focused, setFocused, spotlight, colourBy }: Props) => {
  // Read by the click handler, which must stay referentially stable or the
  // memoised node layer re-renders on every hover — the thing this avoids.
  const focusedRef = useRef<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(
    null,
  )
  /** Live pointers, so two fingers can pinch. */
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ apart: number; zoom: number } | null>(null)
  /** Whether the gesture that just ended moved the map, read by the click. */
  const dragged = useRef(false)
  /** A click event does not carry it, and touch has to behave differently. */
  const lastPointer = useRef<string>('mouse')

  /** Who each node touches, so hovering one can dim everything it does not. */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const join = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set())
      map.get(a)?.add(b)
    }
    for (const { source, target } of graph.edges) {
      join(source, target)
      join(target, source)
    }
    for (const gap of graph.missing) {
      for (const from of gap.from) {
        join(from, gap.slug)
        join(gap.slug, from)
      }
    }
    return map
  }, [graph.edges, graph.missing])

  const at = useMemo(() => new Map(graph.nodes.map((n) => [n.slug, n])), [graph.nodes])

  /**
   * Opening a node, kept out of the layer so the layer can be memoised.
   *
   * A drag that ended on a node is a drag, not a click. And on a touch screen
   * the gesture that reveals a node IS the gesture that opens it, so the first
   * tap reads it and only a second one follows the link.
   */
  const openNode = useCallback(
    (slug: string, event: React.MouseEvent) => {
      if (dragged.current) event.preventDefault()
      else if (lastPointer.current === 'touch' && focusedRef.current !== slug) {
        event.preventDefault()
        setFocused(slug)
      }
    },
    // `setFocused` arrives from the shell as React's own state setter, which
    // is stable for the life of the component — so naming it here keeps the
    // dependency honest without costing the referential stability the
    // memoised node layer depends on.
    [setFocused],
  )

  /**
   * The frame, fitted to what is actually drawn.
   *
   * Sized from the extremes of every node and stub rather than from the
   * layout's own numbers, because a dangling stub sits outside the island it
   * hangs off and would otherwise be clipped at the edge.
   */
  const box = useMemo(() => {
    const xs = [...graph.nodes.map((n) => n.x), ...graph.missing.map((m) => m.x)]
    const ys = [...graph.nodes.map((n) => n.y), ...graph.missing.map((m) => m.y)]
    if (xs.length === 0) return { x: 0, y: 0, w: 100, h: 100 }
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    // Floored at something drawable. A single entry puts every coordinate at
    // zero, and a 1-unit box against a node of radius 2.6 with a halo of 8.3
    // scaled that one dot to fill the window.
    const w = Math.max(90, Math.max(...xs) - minX)
    const h = Math.max(90, Math.max(...ys) - minY)
    const pad = Math.max(w, h) * MARGIN
    return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 }
  }, [graph.nodes, graph.missing])

  /**
   * How many CSS pixels one viewBox unit is worth, at zoom 1.
   *
   * Everything below used to reach for `rect.width / box.w` instead, and that
   * is only the same number when the element happens to have the viewBox's
   * aspect ratio. An SVG with no `preserveAspectRatio` is laid out `xMidYMid
   * meet`: it is fitted by whichever axis is tighter and LETTERBOXED on the
   * other. Using the width ratio made the pointer maths exact on the fitting
   * axis and wrong on the other one, which is why zoom anchored vertically and
   * slid horizontally, and why a drag moved the map at 75% of the cursor.
   *
   * One number, measured, and every gesture goes through it.
   */
  // Named for the element, not for a size, because the label pass below has
  // its own `size` — the font's — and two of those in one component is a trap.
  const [frame, setFrame] = useState({ w: 0, h: 0 })
  const fit = Math.min(frame.w / box.w, frame.h / box.h) || 1

  /**
   * Which titles to draw, chosen so that none lands on another.
   *
   * Drawn by importance and skipped on collision. Without this the dense
   * clusters stacked a dozen titles into one grey smear — worse than no labels
   * at all, because it hid the nodes underneath as well as itself.
   *
   * The text is sized in SCREEN units, not map units, so zooming in does not
   * magnify the same wall of text: the boxes shrink against the map, more of
   * them fit, and the corpus labels itself as you go in. Which is the
   * behaviour anyone who has used a map expects.
   */
  /**
   * Zoom, in steps, for the labels only.
   *
   * The collision pass is cheap but it is not free, and a trackpad delivers a
   * hundred zoom events a second. Rounding to quarter-steps means it runs when
   * the set of labels could actually change, rather than on every tick.
   */
  const labelZoom = Math.max(0.5, Math.round(zoom * 4) / 4)
  /** Quantised for the same reason, so dragging a window edge is not a storm. */
  const labelFit = Math.max(0.05, Math.round(fit * 50) / 50)

  /**
   * How big a title should be once it is on the glass, in CSS pixels.
   *
   * It used to be 7.6 viewBox units divided by the zoom, which holds the size
   * against the ZOOM but not against the FIT — and the fit collapses when the
   * window narrows. On a phone that put every title at 3px: not small text,
   * an illegible grey smear laid over the dots. Dividing by the fit as well
   * makes the number mean what it says.
   */
  const LABEL_PX = 11

  const labels = useMemo(() => {
    const size = LABEL_PX / (labelFit * labelZoom)
    const near = focused ? neighbours.get(focused) : null
    const candidates = focused
      ? graph.nodes
          .filter((n) => n.slug === focused || (near?.has(n.slug) ?? false))
          .sort((a, b) => (a.slug === focused ? -1 : b.slug === focused ? 1 : b.degree - a.degree))
      : graph.nodes.filter((n) => n.degree >= LABEL_AT).sort((a, b) => b.degree - a.degree)

    const placed: { x: number; y: number; w: number; h: number }[] = []
    const out: { node: GraphNode; text: string; size: number }[] = []

    for (const n of candidates.slice(0, 160)) {
      const text = n.title.length > 42 ? `${n.title.slice(0, 41)}…` : n.title
      // Close enough for a box test, and far cheaper than measuring text.
      const w = text.length * size * 0.5
      const h = size * 1.35
      const x = n.x - w / 2
      const y = n.y - radiusOf(n.degree) - 4 - h

      const clash = placed.some(
        (b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y,
      )
      if (clash) continue

      placed.push({ x, y, w, h })
      out.push({ node: n, text, size })
      if (out.length >= 60) break
    }
    return out
  }, [graph.nodes, focused, labelZoom, labelFit, neighbours])

  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])


  useEffect(() => {
    focusedRef.current = focused
  }, [focused])

  const svg = useRef<SVGSVGElement>(null)

  // Measured rather than assumed: the fit scale above is the one number every
  // gesture and the label sizing depend on, and it changes with the window.
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setFrame({ w: element.clientWidth, h: element.clientHeight })
    })
    observer.observe(element)
    setFrame({ w: element.clientWidth, h: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  /**
   * Zoom, anchored where the pointer is.
   *
   * Anchored to the centre of the box it pushed whatever you were looking at
   * off the screen, so reading one island meant alternating zoom and drag.
   * Keeping the point under the cursor fixed is what every map does.
   */
  const zoomTo = useCallback(
    (want: number | ((current: number) => number), clientX?: number, clientY?: number) => {
      const element = svg.current
      setZoom((current) => {
        const asked = typeof want === 'function' ? want(current) : want
        const next = Math.min(8, Math.max(0.6, asked))
        if (!element || clientX === undefined || clientY === undefined) return next

        const rect = element.getBoundingClientRect()
        // The drawing does not fill the element: it is fitted by the tighter
        // axis and centred, leaving a letterbox on the other. The cursor's
        // position has to be measured against the DRAWING, not the element,
        // or the anchor is off by half the letterbox and the map slides
        // toward the centre on every tick.
        const drawnW = box.w * fit
        const drawnH = box.h * fit
        const padX = (rect.width - drawnW) / 2
        const padY = (rect.height - drawnH) / 2
        const fx = (clientX - rect.left - padX) / (drawnW || 1) - 0.5
        const fy = (clientY - rect.top - padY) / (drawnH || 1) - 0.5
        const shownW = box.w / current
        const shownH = box.h / current
        const grownW = box.w / next
        const grownH = box.h / next
        setPan((p) => ({
          x: p.x + fx * (grownW - shownW),
          y: p.y + fy * (grownH - shownH),
        }))
        return next
      })
    },
    [box.w, box.h, fit],
  )
  /** The common case: step by a factor, from whatever the zoom is now. */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) =>
      zoomTo((current) => current * factor, clientX, clientY),
    [zoomTo],
  )

  /**
   * The wheel, attached by hand.
   *
   * React registers `wheel` passively, so `preventDefault` inside an `onWheel`
   * prop does nothing at all — the browser logs that it was ignored. Nothing
   * scrolled only because this page happens not to, and ctrl+wheel still
   * zoomed the browser and the map at once.
   */
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  return (
    <>
      <svg
        ref={svg}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="graph block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="img"
        aria-label={`${graph.stats.entries} knowledge entries, ${graph.edges.length} links between them, ${graph.stats.isolated} joined to nothing`}
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            panX: pan.x,
            panY: pan.y,
            moved: false,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (touches.current.has(event.pointerId)) {
            touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          }

          /**
           * Two fingers: pinch.
           *
           * `touch-action: none` is what lets this pan at all, and it also
           * turns off the browser's own pinch — so without this the map had no
           * zoom whatsoever on a phone, which meant 377 nodes as sub-pixel
           * dots with no way to get closer.
           */
          if (touches.current.size >= 2) {
            const [a, b] = [...touches.current.values()]
            if (a && b) {
              const apart = Math.hypot(a.x - b.x, a.y - b.y)
              if (!pinch.current) pinch.current = { apart, zoom }
              else if (pinch.current.apart > 0) {
                // Set outright, rather than as a factor against `zoom`. Two
                // fingers deliver two pointermove events per frame and `zoom`
                // is the value from the last COMMITTED render, so the second
                // of the pair divided by a number React had not updated yet.
                // The gesture still arrived roughly where it should, in
                // alternating large and small steps — a pinch that stuck and
                // then lurched.
                zoomTo(
                  pinch.current.zoom * (apart / pinch.current.apart),
                  (a.x + b.x) / 2,
                  (a.y + b.y) / 2,
                )
              }
            }
            drag.current = null
            return
          }

          const from = drag.current
          if (!from) return
          if (event.pointerType === 'mouse' && event.buttons === 0) {
            drag.current = null
            return
          }
          // Screen pixels are viewBox units scaled by the fit AND the zoom, so
          // a drag has to be divided back out through both or the map does not
          // keep up with the cursor. This was `box.w / clientWidth / zoom`,
          // which is the width ratio — on a window wider than the drawing's
          // aspect that is larger than the true fit scale, and the map
          // travelled 75% of the distance the hand did.
          const scale = 1 / (fit * zoom)
          if (Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > 4) {
            from.moved = true
          }
          setPan({
            x: from.panX + (event.clientX - from.x) * scale,
            y: from.panY + (event.clientY - from.y) * scale,
          })
        }}
        onPointerUp={(event) => {
          touches.current.delete(event.pointerId)
          if (touches.current.size < 2) pinch.current = null
          dragged.current = drag.current?.moved ?? false
          drag.current = null
        }}
        onDoubleClick={reset}
        onPointerCancel={(event) => {
          // Without this a cancelled gesture — a long-press menu, a touch the
          // system took over — leaves the drag open, and since pointermove
          // fires on plain hover the map then pans with no button held.
          touches.current.delete(event.pointerId)
          pinch.current = null
          drag.current = null
        }}
      >
        <defs>
          {/* Light falls off around a node instead of stopping at its edge.
              Two circles rather than a blur filter: a filter over hundreds of
              nodes is a repaint the browser struggles with, and this costs
              nothing. */}
          <radialGradient id="halo">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.12" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
          {/* The same light, weaker, for the entries that belong to no
              project. Those are drawn in --fg-muted, and a grey glow on a
              white ground has no hue to separate it from the paper — it
              stopped reading as light and started reading as a dirty smudge
              behind the cluster, or as a compression artefact. Every other
              node is a saturated project colour and glows cleanly on both
              grounds, so this is the one case that needed its own stops
              rather than a change to all of them. */}
          <radialGradient id="halo-global">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="45%" stopColor="currentColor" stopOpacity="0.05" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g
          transform={`translate(${box.x + box.w / 2} ${box.y + box.h / 2}) scale(${zoom}) translate(${-(box.x + box.w / 2) + pan.x} ${-(box.y + box.h / 2) + pan.y})`}
        >
          <EdgeLayer
            graph={graph}
            at={at}
            neighbours={neighbours}
            focused={focused}
            spotlight={spotlight}
            onFocus={setFocused}
          />

          <MissingLayer
            graph={graph}
            at={at}
            neighbours={neighbours}
            focused={focused}
            spotlight={spotlight}
            onFocus={setFocused}
          />

          <NodeLayer
            graph={graph}
            at={at}
            neighbours={neighbours}
            focused={focused}
            spotlight={spotlight}
            onFocus={setFocused}
            onOpen={openNode}
            colourBy={colourBy}
          />

          {/* The hubs carry their names without being asked, because a map of
              unlabelled dots tells you the shape and nothing else. Everything
              quieter than that waits to be hovered, or the picture becomes a
              wall of text with a graph behind it. */}
          <g className="pointer-events-none">
            {labels.map(({ node: n, text, size }) => (
              <text
                key={n.slug}
                x={n.x}
                y={n.y - radiusOf(n.degree) - 4}
                textAnchor="middle"
                fill={n.slug === focused ? 'var(--fg)' : 'var(--fg-muted)'}
                fontSize={size}
                stroke="var(--bg)"
                strokeWidth={size * 0.34}
                paintOrder="stroke"
                // No 0.8. --fg-muted is 5.86:1 on white and 5.14:1 on black,
                // both of which clear AA; the 0.8 dropped the light one to
                // 3.76:1 and put it under. The knockout stroke behind the
                // glyphs is what keeps them readable over a dense cluster, and
                // that does not need the text faded to work.
                opacity={1}
              >
                {text}
              </text>
            ))}
          </g>

          {/* The map says what its own regions are. The band along the foot is
              the finding, and a reader should not have to infer it. */}
          {graph.stats.isolated > 0 && graph.nodes.length > graph.isolatedFrom && (
            <text
              x={box.x + box.w * 0.012}
              y={(graph.nodes[graph.isolatedFrom]?.y ?? 0) - 22}
              fill="var(--fg-subtle)"
              fontSize={9}
              stroke="var(--bg)"
              strokeWidth={2.6}
              paintOrder="stroke"
              className="pointer-events-none"
            >
              {graph.stats.isolated} joined to nothing
            </text>
          )}
        </g>
      </svg>


      {/* A wheel is not the only way to zoom, and on a touch screen there is
          no wheel at all. Also the keyboard path into the map, since the nodes
          themselves are deliberately not tab stops. */}
      <div className="border-border bg-surface raised absolute right-2 bottom-2 flex items-center gap-0.5 rounded-full border p-0.5">
        {zoom !== 1 || pan.x !== 0 || pan.y !== 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={reset}
            className="enter-pop rounded-full"
            style={{ '--origin': 'right' } as React.CSSProperties}
          >
            Reset view
          </Button>
        ) : null}
        <Button
          icon
          size="sm"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => zoomAt(0.8)}
          className="rounded-full"
        >
          −
        </Button>
        <Button
          icon
          size="sm"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.25)}
          className="rounded-full"
        >
          +
        </Button>
      </div>
    </>
  )
}

export default GraphFlat
