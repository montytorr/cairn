'use client'

import dynamic from 'next/dynamic'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Box, Map as MapIcon, Play, Search, Square, X } from 'lucide-react'
import { Button, Select, Input } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { GraphFlat } from './graph-flat'
import { inSpotlight, spotlightName, spotlightOptions, type Spotlight } from '@/lib/graph-spotlight'
import { COLOUR_MODES, type ColourBy } from '@/lib/graph-colour'
import { hoverAnnouncement, hoverCardFor, placeCard } from '@/lib/graph-hover'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'
import type { Grouping } from './graph-scene'
import type { Arrange } from '@/lib/graph-3d'

/**
 * The map, and the choice of how to draw it.
 *
 * Two renderers sit under this: the flat SVG one, which is the original and
 * still the honest answer to "how much of this corpus is joined to nothing",
 * and a WebGL scene you can orbit. The shell owns the things that belong to
 * neither — what is under the pointer, the legend, the toggle — so that the
 * hover card reads the same whichever is mounted and hovering a node means the
 * same thing in both.
 *
 * three.js is a large dependency and it is only ever needed here, so the scene
 * is loaded on demand. `ssr: false` is not a preference: it touches `document`
 * to build its textures and reads the stylesheet for the palette, neither of
 * which exist on the server.
 */
const GraphScene = dynamic(() => import('./graph-scene'), {
  ssr: false,
  loading: () => null,
})

type Props = { graph: KnowledgeGraph }

/**
 * The material every piece of chrome over the map is made of: a solid panel
 * with a hairline, and the soft shadow of anything that floats.
 */
const CHROME = 'border-border bg-surface raised border'

// A segment is a compact button in a pill: the shape is the pill's, the size
// and type are the product's.
const SEGMENT = 'rounded-full'


type Mode = 'scene' | 'flat'

const STORAGE = 'cairn:knowledge-map-mode'

/**
 * What the scene's named glows are drawn around, remembered per browser.
 *
 * By project unless somebody chose otherwise: an instance with one entity
 * got one glow around the whole corpus (CAIRN-340). Read straight from
 * storage — it only matters once the scene is drawn, which never happens
 * during the server render or hydration, so the two cannot disagree.
 */
const GROUPING_STORAGE = 'cairn:knowledge-map-grouping'
const readGrouping = (): Grouping => {
  if (typeof window === 'undefined') return 'project'
  try {
    return window.localStorage.getItem(GROUPING_STORAGE) === 'entity' ? 'entity' : 'project'
  } catch {
    return 'project'
  }
}

/**
 * Whether this browser can actually do it.
 *
 * Asked by trying, because the alternatives all lie: a WebGL2 entry in
 * `navigator` says nothing about whether a context can be allocated, and
 * machines with the GPU blocklisted report support right up until creation
 * fails. A failed probe here is what keeps the flat map on screen instead of a
 * black rectangle.
 *
 * Asked exactly once, and the answer kept. The probe allocates a real context,
 * and it is read on every render through `useSyncExternalStore`, which
 * compares what it gets back by identity — an uncached boolean would be a new
 * probe per render and a new context per probe.
 */
let probed: { able: boolean; mode: Mode } | null = null

const capability = (): { able: boolean; mode: Mode } => {
  if (probed) return probed
  let able = false
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl) {
      able = true
      // Released immediately: a probe that keeps its context spends one of the
      // handful the browser will hand out.
      ;(gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    able = false
  }
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(STORAGE)
  } catch {
    // Private windows and blocked site data both throw here, and a remembered
    // preference is not worth failing a render over.
  }
  probed = { able, mode: able && saved !== 'flat' ? 'scene' : 'flat' }
  return probed
}

/**
 * Nothing to subscribe to: the answer cannot change while the page is open.
 *
 * `useSyncExternalStore` rather than a `useState` set from an effect, because
 * this is exactly what it is for — a value React cannot compute during render
 * on the server, read consistently on the client. Done with an effect instead,
 * the first paint is always the flat map and a capable browser then re-renders
 * into the scene, which is the cascading render the rule warns about and which
 * anyone on WebGL would see as a flash.
 */
const noSubscribe = () => () => {}
/** The server has no canvas, and the flat map is the safe thing to agree on. */
const onServer = (): { able: boolean; mode: Mode } => SERVER_STATE
const SERVER_STATE: { able: boolean; mode: Mode } = { able: false, mode: 'flat' }

/**
 * The same graph as last time, as the same object, until its content changes.
 *
 * LiveUpdates refreshes the page on every poll, and every refresh hands down
 * a freshly built object with identical content. The scene is built in one
 * effect keyed on it, so each poll tore the scene down and rebuilt it, and
 * the camera replayed its arrival: the map zoomed out and back in every few
 * seconds while nothing had changed. Compared by value, the render-time state
 * pattern the boards use for their props.
 */
export const useStableGraph = (graph: Props['graph']) => {
  // Once per refresh, not once per hover: the prop only changes on a poll.
  const key = useMemo(() => JSON.stringify(graph), [graph])
  const [kept, setKept] = useState({ key, graph })
  if (kept.key !== key) setKept({ key, graph })
  return kept.key === key ? kept.graph : graph
}

export const GraphView = ({ graph: incoming }: Props) => {
  const graph = useStableGraph(incoming)
  const [focused, setFocused] = useState<string | null>(null)
  /** One project or one world, lit against everything else. */
  const [spotlight, setSpotlight] = useState<Spotlight>(null)

  const [touring, setTouring] = useState(false)
  const { able, mode: preferred } = useSyncExternalStore(noSubscribe, capability, onServer)
  /** What the toggle was last set to, which outranks the remembered answer. */
  const [chosen, setChosen] = useState<Mode | null>(null)
  const mode = able ? (chosen ?? preferred) : 'flat'

  const [groupingChoice, setGroupingChoice] = useState<Grouping>(readGrouping)
  // With fewer than two entities, grouping by entity is one glow or none, so
  // the choice is not offered at all.
  const entityCount = useMemo(
    () => new Set(graph.nodes.map((n) => n.entity).filter(Boolean)).size,
    [graph.nodes],
  )
  const canGroupByEntity = entityCount >= 2
  const grouping: Grouping = canGroupByEntity ? groupingChoice : 'project'
  const chooseGrouping = useCallback((next: Grouping) => {
    setGroupingChoice(next)
    try {
      window.localStorage.setItem(GROUPING_STORAGE, next)
    } catch {
      // Remembering is a convenience, not a requirement.
    }
  }, [])

  const stopTour = useCallback(() => {
    setTouring(false)
    setSpotlight(null)
  }, [])

  const choose = useCallback((next: Mode) => {
    setChosen(next)
    setFocused(null)
    setTouring(false)
    try {
      window.localStorage.setItem(STORAGE, next)
    } catch {
      // As above: remembering is a convenience, not a requirement.
    }
  }, [])

  const at = useMemo(() => new Map(graph.nodes.map((n) => [n.slug, n])), [graph.nodes])

  const titles = useMemo(
    () => new Map(graph.entities.map((e) => [e.key, e.title])),
    [graph.entities],
  )
  const options = useMemo(() => spotlightOptions(graph.nodes, titles), [graph.nodes, titles])
  const litCount = useMemo(
    () => (spotlight ? graph.nodes.filter((n) => inSpotlight(n, spotlight)).length : 0),
    [graph.nodes, spotlight],
  )
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [colourBy, setColourBy] = useState<ColourBy>('project')
  const [arrange, setArrange] = useState<Arrange>('clusters')
  const search = useCallback((text: string) => {
    setQuery(text)
    setSpotlight(text.trim() ? { kind: 'find', key: text.trim() } : null)
  }, [])
  // `/` is the search box, unless a field already has the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const card = useMemo(
    () => hoverCardFor(focused, at, graph.missing, titles),
    [focused, at, graph.missing, titles],
  )

  /**
   * Where the pointer last was, and the card that follows it (CAIRN-349).
   *
   * Kept in refs and written straight to the card's transform, for the reason
   * the scene writes its titles straight to the DOM: a React render per
   * pointermove is a render of both renderers' parents on every frame of
   * every hover. React renders when what is hovered changes; where it is
   * hovered is the DOM's business. Listened for here, on the container,
   * rather than threaded out of each renderer — both of them bubble, and
   * neither needs to know a card exists.
   */
  const frameRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ x: number; y: number } | null>(null)
  const pressed = useRef<{ x: number; y: number } | null>(null)
  const pending = useRef(0)

  const place = useCallback(() => {
    pending.current = 0
    const frame = frameRef.current
    const el = cardRef.current
    if (!frame || !el) return
    const point = anchor.current
    // Nowhere to put it yet: a focus that arrived before any pointer position
    // is better shown nowhere than in the corner it used to live in.
    if (!point) {
      el.style.visibility = 'hidden'
      return
    }
    // Every read before the write, so placing the card never forces a second
    // layout in the same frame.
    const rect = frame.getBoundingClientRect()
    const { left, top } = placeCard({
      x: point.x - rect.left,
      y: point.y - rect.top,
      width: el.offsetWidth,
      height: el.offsetHeight,
      boundsWidth: frame.clientWidth,
      boundsHeight: frame.clientHeight,
    })
    el.style.transform = `translate3d(${left}px, ${top}px, 0)`
    el.style.visibility = ''
  }, [])

  /** At most once a frame, however fast the pointer reports. */
  const schedule = useCallback(() => {
    if (!pending.current) pending.current = requestAnimationFrame(place)
  }, [place])

  useEffect(() => () => cancelAnimationFrame(pending.current), [])

  // New content is a new size, so the flip has to be worked out again. Before
  // paint, so a card never shows for a frame where the last one fitted.
  useLayoutEffect(() => {
    if (card) place()
  }, [card, place])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      // A finger dragging to orbit or pan is not pointing at anything, and a
      // card chasing it would cover what the drag is moving.
      if (event.pointerType === 'touch') return
      anchor.current = { x: event.clientX, y: event.clientY }
      schedule()
    },
    [schedule],
  )
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      pressed.current = { x: event.clientX, y: event.clientY }
      if (event.pointerType === 'touch') return
      anchor.current = { x: event.clientX, y: event.clientY }
      schedule()
    },
    [schedule],
  )
  /**
   * There is no hover on a touch screen: the first tap is what focuses a node
   * in both renderers, so a tap is what anchors the card. Only a tap — a drag
   * that started over the focused node should leave the card where it was
   * read, not where the drag began.
   */
  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      const from = pressed.current
      pressed.current = null
      if (event.pointerType !== 'touch' || !from) return
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 8) return
      anchor.current = { x: event.clientX, y: event.clientY }
      schedule()
    },
    [schedule],
  )

  return (
    <div
      ref={frameRef}
      className="relative h-full w-full overflow-hidden"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {mode === 'scene' && able ? (
        <GraphScene
          graph={graph}
          focused={focused}
          onHover={setFocused}
          spotlight={spotlight}
          grouping={grouping}
          colourBy={colourBy}
          arrange={arrange}
          tour={touring}
          onTourStep={(key) => {
            setQuery('')
            setSpotlight({ kind: grouping === 'entity' ? 'entity' : 'project', key })
          }}
          onTourStop={stopTour}
        />
      ) : (
        <GraphFlat
          graph={graph}
          focused={focused}
          setFocused={setFocused}
          spotlight={spotlight}
          colourBy={colourBy}
        />
      )}

      {/* What is under the pointer, at the pointer. One card, written once,
          over either renderer — hovering a node has to mean the same thing in
          both or the toggle stops being a change of view and becomes a change
          of page. It used to be the corner bar, which on a large screen sat so
          far from the node that hovering looked like it did nothing
          (CAIRN-349). No transition on the transform: it follows the pointer
          exactly or not at all, which is also what reduced motion asks for. */}
      <div
        ref={cardRef}
        data-hover-card
        aria-hidden
        style={{ visibility: 'hidden' }}
        className={cn(
          CHROME,
          'pointer-events-none absolute top-0 left-0 z-10 w-max max-w-[min(18rem,calc(100%-1rem))] rounded-lg px-2.5 py-2 text-meta leading-snug',
          !card && 'hidden',
        )}
      >
        {card?.kind === 'entry' ? (
          <>
            <p className="text-fg line-clamp-2 font-medium">{card.title}</p>
            {/* The world it belongs to is what the coloured regions in the
                scene are, so it is named here — but only when it is not the
                project key said twice. */}
            <p className="text-fg-subtle mt-0.5">{card.meta}</p>
            {card.excerpt ? <p className="text-fg-muted mt-1.5">{card.excerpt}</p> : null}
          </>
        ) : card?.kind === 'missing' ? (
          <>
            <p className="text-danger line-clamp-2 font-medium break-all">{card.slug}</p>
            <p className="text-fg-subtle mt-0.5">{card.detail}</p>
          </>
        ) : null}
      </div>
      {/* The card is drawn for the eye and hidden from assistive tech; this is
          what the corner bar used to give a screen reader. */}
      <p className="sr-only" aria-live="polite">
        {hoverAnnouncement(card)}
      </p>

      {/* How to use it, and what the spotlight has lit. Written for whatever is
          actually being used: on a phone the flat map's bar read "Hover a node
          · scroll to zoom", naming two gestures that do not exist there and
          omitting the one that does.
          Narrower than half the map less the picker, so a long line wraps
          beside the spotlight instead of sliding under it; on a phone, where
          there is no room beside it at all, it moves to the foot, which the
          legend leaves free there. */}
      <div
        className={cn(
          CHROME,
          'text-fg-subtle pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-11rem)] rounded-lg px-2.5 py-1.5 text-meta leading-snug sm:top-2 sm:bottom-auto sm:max-w-[calc(50%-8.5rem)]',
        )}
      >
        {spotlight ? (
          <span className="text-fg">
            {litCount} {litCount === 1 ? 'entry' : 'entries'}{' '}
            {spotlight.kind === 'find' ? 'match' : 'in'} {spotlightName(spotlight)}
            <span className="text-fg-subtle"> · everything else dimmed</span>
          </span>
        ) : (
          <>
            <span className="hidden sm:inline">
              {mode === 'scene' && able
                ? 'Hover to name it · drag to orbit · scroll toward the cursor · double-click to reset'
                : 'Hover a node · drag to pan · scroll to zoom · double-click to reset'}
            </span>
            <span className="sm:hidden">
              {mode === 'scene' && able
                ? 'Tap a node · drag to orbit · pinch to move in · double-tap to reset'
                : 'Tap a node · drag to pan · pinch to zoom'}
            </span>
          </>
        )}
      </div>

      {/* Where is my project on this map.
          Grouping by project was the other way to answer it, and the corpus
          argues against: a median of three entries per project, eight of
          fifteen under five, and 12% belonging to none. Thirty-five
          gravitational wells over that is confetti. A highlight answers the
          same question without moving anything, which is also more honest —
          you see how scattered a project's knowledge really is rather than a
          clump the layout invented. */}
      <div className="absolute top-[0.625rem] left-1/2 flex -translate-x-1/2 items-center gap-1.5">
        <div className={cn(CHROME, 'relative flex items-center rounded-md')}>
          <Search size={13} aria-hidden className="text-fg-subtle pointer-events-none absolute left-2" />
          <Input
            ref={searchRef}
            size="sm"
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                search('')
                e.currentTarget.blur()
              }
            }}
            placeholder="Find an entry  /"
            aria-label="Find an entry by title or slug"
            className="w-36 pl-7 sm:w-48"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => search('')}
              className="text-fg-subtle hover:text-fg absolute right-1.5"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="raised flex rounded-md">
        <Select
          size="sm"
          aria-label="Light up one project or entity"
          className="max-w-[14rem]"
          value={spotlight && spotlight.kind !== 'find' ? `${spotlight.kind}:${spotlight.key}` : ''}
          onChange={(e) => {
            const v = e.target.value
            setQuery('')
            if (!v) return setSpotlight(null)
            const [kind, key] = v.split(':')
            setSpotlight({ kind: kind as 'project' | 'entity' | 'island', key: key as string })
          }}
        >
          <option value="">Everything</option>
          {options.entities.length > 0 ? (
            <optgroup label="Worlds">
              {options.entities.map((o) => (
                <option key={`entity:${o.key}`} value={`entity:${o.key}`}>
                  {o.label} ({o.count})
                </option>
              ))}
            </optgroup>
          ) : null}
          {options.projects.length > 0 ? (
            <optgroup label="Projects">
              {options.projects.map((o) => (
                <option key={`project:${o.key}`} value={`project:${o.key}`}>
                  {o.label} ({o.count})
                </option>
              ))}
            </optgroup>
          ) : null}
          {options.islands.length > 0 ? (
            <optgroup label="Islands">
              {options.islands.map((o) => (
                <option key={`island:${o.key}`} value={`island:${o.key}`}>
                  {o.label} ({o.count})
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        </div>
      </div>

      {/* Flat or spatial. Offered rather than decided, because the two are
          good at different things: the scene shows how the corpus clusters,
          the flat map shows what is joined to nothing without anything being
          able to hide behind anything else. Hidden entirely where WebGL is
          unavailable — a toggle to something that cannot be drawn is worse
          than no toggle. */}
      <div className="absolute top-2 right-2 flex flex-col items-end gap-1.5">
        {able ? (
          <div
            role="group"
            aria-label="How to draw the map"
            className={cn(CHROME, 'flex items-center gap-0.5 rounded-full p-0.5')}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={mode === 'scene'}
              onClick={() => choose('scene')}
              title="Spatial — drag to orbit"
              className={SEGMENT}
            >
              <Box size={13} aria-hidden />
              Spatial
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={mode === 'flat'}
              onClick={() => choose('flat')}
              title="Flat — every entry visible at once"
              className={SEGMENT}
            >
              <MapIcon size={13} aria-hidden />
              Flat
            </Button>
          </div>
        ) : null}
        <div
          role="group"
          aria-label="What the colour says"
          className={cn(CHROME, 'flex items-center gap-0.5 rounded-full p-0.5')}
        >
          {COLOUR_MODES.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant="ghost"
              aria-pressed={colourBy === m.key}
              onClick={() => setColourBy(m.key)}
              title={m.hint}
              className={SEGMENT}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {able ? (
          <>
          {mode === 'scene' ? (
            <div
              role="group"
              aria-label="How the spatial map is arranged"
              className={cn(CHROME, 'flex items-center gap-0.5 rounded-full p-0.5')}
            >
              {(['clusters', 'links'] as const).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant="ghost"
                  aria-pressed={arrange === a}
                  onClick={() => setArrange(a)}
                  title={a === 'clusters' ? 'Every project gets a place of its own' : 'Let the links decide where things sit'}
                  className={SEGMENT}
                >
                  {a === 'clusters' ? 'Clusters' : 'Links'}
                </Button>
              ))}
            </div>
          ) : null}
          {mode === 'scene' ? (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={touring}
              onClick={() => (touring ? stopTour() : setTouring(true))}
              title={touring ? 'Stop the tour' : 'Fly from project to project'}
              className={cn(CHROME, SEGMENT)}
            >
              {touring ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}
              {touring ? 'Stop' : 'Tour'}
            </Button>
          ) : null}
          {/* Only where it changes something: the glows are the scene's, and
              with one entity there is nothing to choose between. */}
          {mode === 'scene' && canGroupByEntity ? (
            <div
              role="group"
              aria-label="What the glows group"
              className={cn(CHROME, 'flex items-center gap-0.5 rounded-full p-0.5')}
            >
              {(['project', 'entity'] as const).map((g) => (
                <Button
                  key={g}
                  size="sm"
                  variant="ghost"
                  aria-pressed={grouping === g}
                  onClick={() => chooseGrouping(g)}
                  title={g === 'project' ? 'A glow around each project' : 'A glow around each entity'}
                  className={SEGMENT}
                >
                  {g === 'project' ? 'Projects' : 'Entities'}
                </Button>
              ))}
            </div>
          ) : null}
          </>
        ) : null}
      </div>

      {/* The legend, because "what are the dotted red circles?" was the first
          thing asked after ten minutes of looking at this. Every mark on the
          map means something and none of it was stated where it was being
          read. */}
      <dl className={cn(CHROME, 'text-fg-subtle pointer-events-none absolute bottom-2 left-2 hidden space-y-1 rounded-lg px-2.5 py-2 text-meta sm:block')}>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="5" cy="5" r="2" fill="var(--fg-muted)" />
            <circle cx="18" cy="5" r="4.5" fill="var(--fg-muted)" />
          </svg>
          <dd>bigger — more links to other entries</dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="6" cy="5" r="3.5" fill="var(--accent)" />
            <circle cx="18" cy="5" r="3.5" fill="var(--fg-subtle)" />
          </svg>
          <dd>
            {colourBy === 'project'
              ? 'coloured by project · grey is global'
              : COLOUR_MODES.find((m) => m.key === colourBy)?.hint}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle
              cx="12"
              cy="5"
              r="4"
              fill="none"
              stroke="var(--danger)"
              strokeWidth="1.3"
              strokeDasharray="2.5 2"
            />
          </svg>
          <dd className="text-danger">referenced, but never written</dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="4" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
            <circle cx="12" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
            <circle cx="20" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
          </svg>
          <dd>
            {mode === 'scene' && able
              ? 'the shell around it — joined to nothing'
              : 'the band at the foot — joined to nothing'}
          </dd>
        </div>
        {/* Only in the scene, because only the scene draws them. A legend
            entry for something that is not on screen is worse than none. */}
        {mode === 'scene' && able ? (
          <div className="flex items-center gap-2">
            <svg width="26" height="10" aria-hidden className="shrink-0">
              <defs>
                <radialGradient id="legend-world">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </radialGradient>
              </defs>
              <circle cx="13" cy="5" r="9" fill="url(#legend-world)" />
            </svg>
            <dd>
              {grouping === 'project'
                ? 'a named glow — one project, where its entries settled'
                : 'a named glow — one entity, the world a project belongs to'}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
