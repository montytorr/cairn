'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { entityColor, projectColor } from '@/components/icons'
import { groupsOf, layout3D, type Arrange } from '@/lib/graph-3d'
import { inSpotlight, type Spotlight } from '@/lib/graph-spotlight'
import { mapNow, nodeColour, type ColourBy } from '@/lib/graph-colour'
import type { KnowledgeGraph, GraphNode } from '@/lib/api/knowledge-graph'

/**
 * The map as a place you can move through.
 *
 * The flat version of this page opens with an argument against exactly this,
 * and the argument has not stopped being true: depth puts things behind other
 * things, and the one finding the page exists to deliver is how much of the
 * corpus is joined to nothing. Three things answer it, and all three are load
 * bearing rather than decoration.
 *
 * The entries joined to nothing are not in the cloud. They sit on a lit disc
 * underneath it, in a sunflower spiral, and nothing is drawn between the
 * camera and that disc — see `layout3D`. You can orbit to any angle the
 * controls allow and still count them.
 *
 * The camera is clamped off both poles, so there is no angle from which the
 * cloud collapses to the edge-on line a free camera finds immediately.
 *
 * And the flat map is still here: still the fallback where WebGL is missing,
 * one click away on a toggle. Nothing was removed to add this.
 *
 * Geometry is instanced — one draw call for every sphere, one for every link,
 * one for the glow. Positions come from `layout3D`, which is deterministic, so
 * this scene is as stable between renders as the flat one: a `router.refresh()`
 * landing mid-orbit changes nothing about where anything is.
 */

type Props = {
  graph: KnowledgeGraph
  /** Lifted, so the shell can draw one hover card over either renderer. */
  onHover: (slug: string | null) => void
  focused: string | null
  /** One project or world lit against the rest, or null for all of it. */
  spotlight: Spotlight
  /** What the named glows are drawn around: each project, or each entity. */
  grouping: Grouping
  /** What the dots' colour says. Changing it rebuilds the scene with the camera kept. */
  colourBy?: ColourBy
  /** Whether projects get a place of their own or the links decide. */
  arrange?: Arrange
}

export type Grouping = 'project' | 'entity'

/** A radius that makes a hub look like one, in world units. */
const radiusOf = (degree: number): number =>
  degree === 0 ? 1.5 : 0.85 + Math.min(2.4, Math.sqrt(degree) * 0.66)

/** How many titles can be on screen before it is a wall of text. */
const LABEL_CAP = 34

/** Segments per link. Enough for the bow to read as a curve, not a dogleg. */
const BOW = 10

/** Deterministic, and the same hash the layout and the palette use. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}
const unit = (key: string, salt: number): number =>
  ((hash(key) ^ (salt * 0x9e3779b1)) >>> 0) / 4294967296

type Palette = {
  bg: THREE.Color
  muted: THREE.Color
  accent: THREE.Color
  danger: THREE.Color
  /** Whether we are on the dark ground, which changes how light is mixed. */
  dark: boolean
}

const readPalette = (): Palette => {
  const style = getComputedStyle(document.documentElement)
  const of = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim()
    try {
      return new THREE.Color(raw || fallback)
    } catch {
      return new THREE.Color(fallback)
    }
  }
  const bg = of('--bg', '#08090a')
  // Luminance rather than a theme class, so this stays right even if the
  // ground is changed to something between the two.
  const dark = bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722 < 0.5
  return {
    bg,
    muted: of('--fg-muted', dark ? '#9aa0a9' : '#61656c'),
    accent: of('--accent', dark ? '#7b86e8' : '#5e6ad2'),
    danger: of('--danger', '#c52828'),
    dark,
  }
}

/**
 * A soft dot and a dashed ring, drawn once each into a canvas.
 *
 * The glow is a sprite rather than a bloom pass. A post-processing chain for
 * one effect costs a second render target and two more full-screen passes, and
 * at this node count it is indistinguishable — the light here comes from
 * hundreds of small sources, not the few blown-out ones bloom is for.
 */
const softDot = (falloff: number): THREE.Texture => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(falloff * 0.4, 'rgba(255,255,255,0.32)')
    g.addColorStop(falloff, 'rgba(255,255,255,0.07)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  return new THREE.CanvasTexture(canvas)
}

const dashedRing = (): THREE.Texture => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 10
    ctx.setLineDash([14, 12])
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 11, 0, Math.PI * 2)
    ctx.stroke()
  }
  return new THREE.CanvasTexture(canvas)
}

/**
 * Points sized per point, in world units, which `PointsMaterial` cannot do.
 *
 * `PointsMaterial` takes one size for the whole cloud. A hub's glow has to be
 * bigger than a leaf's or the light says nothing about the shape, so this is
 * the smallest shader that carries a size and a colour per vertex and still
 * attenuates with distance the way the built-in one does.
 */
const spriteMaterial = (map: THREE.Texture, additive: boolean, opacity: number) =>
  new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      opacity: { value: opacity },
      /**
       * Half the canvas height, which is what the renderer feeds its own
       * `PointsMaterial`. Kept in step with the element on every resize, or
       * the glow is sized for one window and drawn in another.
       */
      scale: { value: 300 },
    },
    // Every attribute and uniform is declared. A raw ShaderMaterial is given
    // the standard matrices and `position` by three.js and nothing else — not
    // `color`, which `vertexColors` only wires up for the built-in materials,
    // and not anything named in `uniforms`. Leaving either implicit is a
    // shader that fails to compile, which takes the whole scene with it.
    vertexShader: `
      uniform float scale;
      attribute float size;
      attribute vec3 color;
      varying vec3 vColour;
      void main() {
        vColour = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (scale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float opacity;
      varying vec3 vColour;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColour, t.a * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })

export const GraphScene = ({ graph, onHover, focused, spotlight, grouping, colourBy = 'project', arrange = 'clusters' }: Props) => {
  const host = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const router = useRouter()

  /** Read by the loop, which must not be rebuilt when the focus changes. */
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    focusedRef.current = focused
  }, [focused])

  /** Same reason: the scene is built once and reads this every frame. */
  const spotRef = useRef<Spotlight>(null)
  useEffect(() => {
    spotRef.current = spotlight
  }, [spotlight])

  const onHoverRef = useRef(onHover)
  useEffect(() => {
    onHoverRef.current = onHover
  }, [onHover])

  const place = useMemo(() => layout3D(graph, arrange), [graph, arrange])
  /** The layout's own worlds are its entities; a project grouping is worked out over the same positions. */
  const groups = useMemo(
    () => (grouping === 'entity' ? place.worlds : groupsOf(place, graph.nodes, (n) => n.project)),
    [grouping, place, graph.nodes],
  )

  /**
   * Where the reader left the camera, kept across rebuilds of the scene.
   *
   * The scene is rebuilt when the corpus really changes — an agent writes an
   * entry while you look — and a rebuild started from scratch: the camera
   * went back out and replayed its arrival, so the map lurched every time the
   * knowledge moved. Saved on teardown, restored on the next build, with the
   * arrival skipped. Only a fresh mount (opening the page, switching from the
   * flat map) arrives.
   */
  const kept = useRef<{
    position: THREE.Vector3
    target: THREE.Vector3
    touched: boolean
  } | null>(null)

  /** Who each entry touches, so looking at one can dim everything it does not. */
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

  const open = useCallback((slug: string) => router.push(`/knowledge/${slug}`), [router])

  useEffect(() => {
    const element = host.current
    const overlay = layer.current
    if (!element || !overlay) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      })
    } catch {
      // No WebGL. The shell has already decided whether to mount this at all;
      // getting here means the check passed and creation still failed, so the
      // honest thing is to draw nothing rather than a broken scene.
      return
    }

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    const canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.touchAction = 'none'
    canvas.style.outline = 'none'
    element.appendChild(canvas)

    let palette = readPalette()
    const scene = new THREE.Scene()
    scene.background = palette.bg.clone()
    // Haze, so distance reads as distance rather than as "smaller". It is the
    // cheapest depth cue there is, and it stops the far side of the cloud
    // competing with the near side for attention.
    scene.fog = new THREE.Fog(palette.bg.getHex(), place.radius * 1.9, place.radius * 6)

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, place.radius * 30)

    /**
     * Fitted to the shell, which is the outermost thing there is.
     *
     * This has been wrong twice, both times by guessing. Framed on the cloud
     * alone the orphans ran off the bottom of the frame (CAIRN-217); framed on
     * a hand-picked multiple, the disc of them took over and squeezed the
     * cloud into a corner. Now the entries joined to nothing are on a shell
     * AROUND everything rather than a plane beneath it, the scene is a sphere
     * centred on the origin — so the bound is just its radius, and no camera
     * angle sees more of it than another. The thing that made framing hard was
     * the shape, not the arithmetic.
     *
     * Solved for the vertical AND horizontal fields, larger distance winning,
     * because the vertical binds on a wide window and the horizontal on a
     * narrow one.
     */
    const FOV = 46
    // The orphan shell is the periphery, so in clusters it may run past the glass a little
    // rather than shrinking every project to fit it.
    const half = place.shell * (arrange === 'clusters' ? 0.8 : 1.05)
    const TARGET = new THREE.Vector3(0, 0, 0)
    const fitFor = (aspect: number) => {
      const vertical = half / Math.tan((FOV * Math.PI) / 360)
      const horizontal = half / Math.tan(Math.atan(Math.tan((FOV * Math.PI) / 360) * aspect))
      // A tenth of headroom, so the outermost node is not flush to the glass.
      return Math.max(vertical, horizontal) * 1.1
    }
    const reach = fitFor(1.8)
    /** Off-axis, because straight-on hides the depth this view exists for. */
    const HOME = new THREE.Vector3(0.42, 0.34, 0.84).normalize().multiplyScalar(reach)
    camera.position.copy(TARGET).add(HOME)
    const resumed = kept.current
    if (resumed) camera.position.copy(resumed.position)

    const controls = new OrbitControls(camera, canvas)
    controls.target.copy(resumed?.target ?? TARGET)
    controls.enableDamping = true
    const DAMPING = 0.075
    controls.dampingFactor = DAMPING
    /**
     * Set when the rotation has to stop DEAD rather than coast.
     *
     * Turning `autoRotate` off only stops it accelerating. The accumulated
     * spherical delta then decays at the damping factor — about thirteen
     * frames at 0.075, a fifth of a second — and measured on the deployed map
     * that coast was just enough to slide a node out from under the cursor
     * that had paused it. Hover dropped, rotation resumed, and it oscillated:
     * stop, drift off, start, catch again.
     *
     * A damping factor of 1 for a single update multiplies that residual by
     * zero, which is the one frame of "stop now" the public API does not
     * otherwise offer.
     */
    let halt = false
    // Rotate and dolly only. Panning as well is three gestures competing for
    // two buttons, and a camera that can be walked far enough from the cloud
    // that there is no way back but the reset.
    controls.enablePan = false
    controls.minDistance = reach * 0.3
    controls.maxDistance = reach * 3
    // Clamped off both poles: straight down the Y axis the cloud collapses to
    // a disc and the floor of orphans disappears edge-on, which are the two
    // things this view must never do.
    controls.minPolarAngle = 0.2
    controls.maxPolarAngle = Math.PI * 0.84
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.85
    /**
     * The wheel moves toward whatever is under the cursor, not the middle.
     *
     * Dollying at the centre means reading anything off-axis is a loop of
     * zoom, drag, zoom, drag — the same complaint the flat map had in
     * CAIRN-214, for the same reason. OrbitControls can do this itself; it
     * moves the orbit target along the way, which is what makes the NEXT drag
     * rotate around what you just moved in to look at rather than around the
     * middle of a scene you have left behind.
     *
     * It works with `enablePan` off: the target is repositioned inside the
     * zoom branch rather than through the pan path.
     */
    controls.zoomToCursor = true

    /** Set the moment the reader touches the controls, so nothing moves under them. */
    let touched = resumed?.touched ?? false
    controls.addEventListener('start', () => {
      touched = true
    })

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    controls.autoRotate = !motion.matches
    controls.autoRotateSpeed = 0.3
    const onMotionChange = () => {
      controls.autoRotate = !motion.matches
    }
    motion.addEventListener('change', onMotionChange)

    const key = new THREE.DirectionalLight(0xffffff, palette.dark ? 1.35 : 1.9)
    key.position.set(1, 1.4, 0.8)
    scene.add(key)
    const rim = new THREE.DirectionalLight(palette.accent.getHex(), palette.dark ? 0.85 : 0.45)
    rim.position.set(-1, -0.4, -0.9)
    scene.add(rim)
    const ambient = new THREE.AmbientLight(0xffffff, palette.dark ? 0.6 : 1)
    scene.add(ambient)

    // ---- what is drawn -------------------------------------------------

    const all = graph.nodes.filter((n) => place.at.has(n.slug))
    /** The cloud, and the disc below it, are drawn by two different meshes. */
    const linked = all.filter((n) => n.degree > 0)
    const adrift = all.filter((n) => n.degree === 0)
    const slugAt = [...linked.map((n) => n.slug), ...adrift.map((n) => n.slug)]
    const byslug = new Map(all.map((n) => [n.slug, n]))
    const rowOf = new Map(linked.map((n, i) => [n.slug, i]))
    const now = mapNow()
    const colourOf = (n: GraphNode) => {
      const css = nodeColour(n, colourBy, now)
      return css ? new THREE.Color(css) : palette.muted.clone()
    }
    let base = linked.map((n) => colourOf(n))

    const sphere = new THREE.SphereGeometry(1, 18, 14)
    const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
    const nodes = new THREE.InstancedMesh(sphere, material, linked.length)
    scene.add(nodes)

    const dummy = new THREE.Object3D()
    linked.forEach((n, i) => {
      const p = place.at.get(n.slug)
      if (!p) return
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.setScalar(radiusOf(n.degree))
      dummy.updateMatrix()
      nodes.setMatrixAt(i, dummy.matrix)
      nodes.setColorAt(i, base[i] as THREE.Color)
    })
    nodes.instanceMatrix.needsUpdate = true
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true

    /**
     * The entries joined to nothing, in a mesh of their own (CAIRN-217).
     *
     * Three things made them uncountable on the deployed map, and all three
     * are fixed by taking them out of the cloud's mesh. They were the smallest
     * nodes in the scene; they were lit, so the disc's own shading worked
     * against them; and being furthest from the camera they took the most fog.
     * Here they are unlit, unfogged and drawn at more than twice the size.
     * Nothing can occlude them on that plane, so none of it costs the cloud
     * anything.
     */
    const adriftMat = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false })
    const orphans = new THREE.InstancedMesh(sphere, adriftMat, adrift.length)
    const adriftColour = palette.muted.clone()
    adrift.forEach((n, i) => {
      const p = place.at.get(n.slug)
      if (!p) return
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.setScalar(radiusOf(0))
      dummy.updateMatrix()
      orphans.setMatrixAt(i, dummy.matrix)
      orphans.setColorAt(i, adriftColour)
    })
    orphans.instanceMatrix.needsUpdate = true
    if (orphans.instanceColor) orphans.instanceColor.needsUpdate = true
    scene.add(orphans)

    // The glow, one additive sprite per node.
    const dot = softDot(0.55)
    const glowGeometry = new THREE.BufferGeometry()
    const glowPos = new Float32Array(linked.length * 3)
    const glowCol = new Float32Array(linked.length * 3)
    const glowSize = new Float32Array(linked.length)
    linked.forEach((n, i) => {
      const p = place.at.get(n.slug)
      if (!p) return
      glowPos.set([p.x, p.y, p.z], i * 3)
      glowSize[i] = radiusOf(n.degree) * 7.5
    })
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(glowPos, 3))
    glowGeometry.setAttribute('color', new THREE.BufferAttribute(glowCol, 3))
    glowGeometry.setAttribute('size', new THREE.BufferAttribute(glowSize, 1))
    // Additive on the dark ground is light. On white it would only wash the
    // picture out, so there it blends normally and reads as a soft shadow —
    // which is also what stops the grey, unprojected entries smudging, the way
    // their halo did on the flat map in light mode.
    const glowMat = spriteMaterial(dot, palette.dark, palette.dark ? 0.5 : 0.16)
    const glow = new THREE.Points(glowGeometry, glowMat)
    glow.frustumCulled = false
    scene.add(glow)

    /**
     * The worlds, as volumes of coloured light.
     *
     * One enormous soft sprite per entity, at the centre of mass its members
     * settled into. Colour is the project everywhere else on this map and in
     * the rest of the app, so the ENTITY — the business or stack a project
     * belongs to — had nowhere to go; it is drawn as position and as light
     * instead. Five worlds over thirty-five projects is the grouping a reader
     * actually thinks in, and the map knew nothing about it.
     *
     * The same trick as the node glow at a hundred times the size, which is
     * why it costs one more point in one more draw call rather than a
     * volumetric anything. Behind everything and writing no depth, so it tints
     * the region without hiding a single node.
     */
    /**
     * A world is painted in the colour of what is actually in it.
     *
     * It used to be `entityColor(key)`, a hash of the name into the same
     * palette the projects use — which meant the glow over the pink Tribe
     * cluster came out green, and the name with it. A region whose colour
     * disagrees with the dots inside it is worse than no colour: it reads as
     * a second, contradictory classification.
     *
     * So each world takes the most common project colour among its own
     * members. Dispofi is blue because nineteen blue-ish projects are what
     * Dispofi IS. Ties break on the project key, so the answer does not
     * depend on iteration order.
     */
    const worldHue = new Map<string, string>()
    // A project's glow is simply the project's own colour.
    if (grouping === 'project') for (const g of groups) worldHue.set(g.key, projectColor(g.key))
    for (const w of grouping === 'entity' ? groups : []) {
      const tally = new Map<string, number>()
      for (const n of linked) {
        if (n.entity !== w.key || !n.project) continue
        tally.set(n.project, (tally.get(n.project) ?? 0) + 1)
      }
      const winner = [...tally.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      )[0]
      worldHue.set(w.key, winner ? projectColor(winner[0]) : entityColor(w.key))
    }

    const haze = softDot(0.95)
    const worldGeometry = new THREE.BufferGeometry()
    const worldPos = new Float32Array(groups.length * 3)
    const worldCol = new Float32Array(groups.length * 3)
    const worldSize = new Float32Array(groups.length)
    groups.forEach((w, i) => {
      worldPos.set([w.x, w.y, w.z], i * 3)
      const c = new THREE.Color(worldHue.get(w.key) ?? entityColor(w.key))
      worldCol.set([c.r, c.g, c.b], i * 3)
      worldSize[i] = w.spread * (arrange === 'clusters' ? 3.4 : 5)
    })
    worldGeometry.setAttribute('position', new THREE.BufferAttribute(worldPos, 3))
    worldGeometry.setAttribute('color', new THREE.BufferAttribute(worldCol, 3))
    worldGeometry.setAttribute('size', new THREE.BufferAttribute(worldSize, 1))
    const worldMat = spriteMaterial(haze, palette.dark, palette.dark ? 0.22 : 0.1)
    const worldHaze = new THREE.Points(worldGeometry, worldMat)
    worldHaze.frustumCulled = false
    worldHaze.renderOrder = -1
    scene.add(worldHaze)

    /**
     * Dust, purely for parallax.
     *
     * A cloud has no scale and no motion of its own until something nearer
     * than it moves faster across the eye. Six hundred dim points, seeded from
     * the slug hash so they are the same every time, and it is the whole
     * difference between moving through something and turning a model.
     */
    const dustN = 600
    const dustGeometry = new THREE.BufferGeometry()
    const dustPos = new Float32Array(dustN * 3)
    const dustCol = new Float32Array(dustN * 3)
    const dustSize = new Float32Array(dustN)
    for (let i = 0; i < dustN; i += 1) {
      const u = unit(`dust${i}`, 11) * 2 - 1
      const t = unit(`dust${i}`, 12) * Math.PI * 2
      const r = reach * (1.15 + unit(`dust${i}`, 13) * 1.8)
      const ring = Math.sqrt(1 - u * u)
      dustPos.set([Math.cos(t) * ring * r, u * r * 0.6, Math.sin(t) * ring * r], i * 3)
      dustCol.set([palette.muted.r, palette.muted.g, palette.muted.b], i * 3)
      dustSize[i] = 0.5 + unit(`dust${i}`, 14) * 1.4
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustCol, 3))
    dustGeometry.setAttribute('size', new THREE.BufferAttribute(dustSize, 1))
    const dustMat = spriteMaterial(dot, palette.dark, palette.dark ? 0.45 : 0.22)
    const dust = new THREE.Points(dustGeometry, dustMat)
    dust.frustumCulled = false
    scene.add(dust)

    // Links.
    const edges = graph.edges.filter((e) => place.at.has(e.source) && place.at.has(e.target))
    /**
     * The same bow the flat map draws, in three dimensions.
     *
     * Straight lines between hundreds of nodes cross into a hatch and every
     * one of them reads the same. A consistent bow separates the crossings and
     * gives the web the look of something grown rather than drawn. Bent AWAY
     * from the origin, so a link always arcs out of the cloud rather than
     * through whatever happens to be in the middle of it.
     */
    const va = new THREE.Vector3()
    const vb = new THREE.Vector3()
    const vmid = new THREE.Vector3()
    const vctrl = new THREE.Vector3()
    const pt = new THREE.Vector3()
    const curveOf = (i: number, t: number, out: THREE.Vector3) => {
      const e = edges[i]
      if (!e) return out
      const p = place.at.get(e.source)
      const q = place.at.get(e.target)
      if (!p || !q) return out
      va.set(p.x, p.y, p.z)
      vb.set(q.x, q.y, q.z)
      vmid.addVectors(va, vb).multiplyScalar(0.5)
      vctrl.copy(vmid).multiplyScalar(1.12)
      const u = 1 - t
      return out
        .copy(va)
        .multiplyScalar(u * u)
        .addScaledVector(vctrl, 2 * u * t)
        .addScaledVector(vb, t * t)
    }
    const linkPos = new Float32Array(edges.length * BOW * 6)
    const linkCol = new Float32Array(edges.length * BOW * 6)
    edges.forEach((_, i) => {
      for (let seg = 0; seg < BOW; seg += 1) {
        const o = (i * BOW + seg) * 6
        curveOf(i, seg / BOW, pt)
        linkPos.set([pt.x, pt.y, pt.z], o)
        curveOf(i, (seg + 1) / BOW, pt)
        linkPos.set([pt.x, pt.y, pt.z], o + 3)
      }
    })
    const linkGeometry = new THREE.BufferGeometry()
    linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPos, 3))
    linkGeometry.setAttribute('color', new THREE.BufferAttribute(linkCol, 3))
    const linkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: palette.dark ? 0.55 : 0.5,
      depthWrite: false,
    })
    scene.add(new THREE.LineSegments(linkGeometry, linkMat))

    /**
     * Light travelling the links of whatever is being looked at.
     *
     * The flat map has had this since CAIRN-208 and the scene did not, which
     * made hovering here feel like less had happened. Only the hovered node's
     * links: a pulse on all 452 is a buffer rewrite every frame, and a map
     * that shimmers everywhere says nothing about anywhere.
     */
    const BEAMS = 96
    const beamGeometry = new THREE.BufferGeometry()
    const beamPos = new Float32Array(BEAMS * 3)
    const beamCol = new Float32Array(BEAMS * 3)
    const beamSize = new Float32Array(BEAMS)
    beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPos, 3))
    beamGeometry.setAttribute('color', new THREE.BufferAttribute(beamCol, 3))
    beamGeometry.setAttribute('size', new THREE.BufferAttribute(beamSize, 1))
    // Additive on the dark ground is light; on white it washes to nothing,
    // which is where the glow already learned this lesson.
    const beamMat = spriteMaterial(dot, palette.dark, palette.dark ? 0.95 : 0.7)
    const beams = new THREE.Points(beamGeometry, beamMat)
    beams.frustumCulled = false
    beams.visible = false
    scene.add(beams)
    /** Which edges the beams are riding, refreshed when the focus changes. */
    let riding: number[] = []

    // References to entries nobody wrote: a dashed tether and a hollow ring.
    const gaps = graph.missing.filter((m) => place.at.has(m.slug))
    const gapPos = new Float32Array(gaps.length * 6)
    const ringPos = new Float32Array(gaps.length * 3)
    gaps.forEach((m, i) => {
      const a = m.from[0] ? place.at.get(m.from[0]) : undefined
      const b = place.at.get(m.slug)
      if (!b) return
      ringPos.set([b.x, b.y, b.z], i * 3)
      if (a) gapPos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })
    const gapGeometry = new THREE.BufferGeometry()
    gapGeometry.setAttribute('position', new THREE.BufferAttribute(gapPos, 3))
    const gapMat = new THREE.LineDashedMaterial({
      color: palette.danger.getHex(),
      dashSize: place.radius * 0.022,
      gapSize: place.radius * 0.022,
      transparent: true,
      opacity: 0.75,
    })
    const gapLines = new THREE.LineSegments(gapGeometry, gapMat)
    gapLines.computeLineDistances()
    scene.add(gapLines)

    const ringTex = dashedRing()
    const ringGeometry = new THREE.BufferGeometry()
    ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPos, 3))
    const ringMat = new THREE.PointsMaterial({
      map: ringTex,
      color: palette.danger.getHex(),
      size: place.radius * 0.05,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const rings = new THREE.Points(ringGeometry, ringMat)
    rings.frustumCulled = false
    scene.add(rings)

    /**
     * The edge of the disc the joined-to-nothing sit on.
     *
     * Without it they are dots hanging below the cloud and the eye files them
     * as part of it. With it they are a region with a boundary, which is what
     * the band along the foot of the flat map was doing.
     */
    // Out of the fog. Fog exists to sell depth inside the cloud; the disc is
    // not competing with anything, and being furthest from the camera it was
    // taking the most haze of anything in the scene.

    // ---- focus ---------------------------------------------------------

    const lit = new THREE.Color()
    const white = new THREE.Color(0xffffff)

    /**
     * A world's name, in ink that survives the ground it is written on.
     *
     * The palette these come from was built for filled marks — a hexagon, a
     * dot — where a mid-tone reads fine against either theme. As TEXT on white
     * the lighter half of it is barely there: measured on the deployed map,
     * pale blue DISPOFI and amber AGENT-PROJECTS were close to illegible. On
     * the dark ground the same colours are fine, so this darkens rather than
     * replaces, and only where it has to. Hue is kept, because hue is what
     * ties the name to its haze and to the dots underneath it.
     */
    const inkCache = new Map<string, string>()
    const worldInk = (key: string): string => {
      const memo = inkCache.get(key + (palette.dark ? 'd' : 'l'))
      if (memo) return memo
      const c = new THREE.Color(worldHue.get(key) ?? entityColor(key))
      if (!palette.dark) c.lerp(new THREE.Color(0x000000), 0.42)
      const out = `#${c.getHexString()}`
      inkCache.set(key + (palette.dark ? 'd' : 'l'), out)
      return out
    }

    const paintFocus = (slug: string | null) => {
      const near = slug ? neighbours.get(slug) : null
      const spot = spotRef.current
      /**
       * Hover wins over the spotlight.
       *
       * A spotlight is the resting state — "I am looking at Dispofi" — and
       * pointing at a node is a question asked on top of it. If the two
       * fought, hovering a neighbour that happens to sit outside the lit
       * project would dim the thing you are pointing at, which is the one
       * result nobody wants from a hover.
       */
      const inSet = (s: string) => {
        if (slug !== null) return slug === s || (near?.has(s) ?? false)
        if (!spot) return true
        const n = byslug.get(s)
        return n ? inSpotlight(n, spot) : false
      }

      for (let i = 0; i < linked.length; i += 1) {
        const n = linked[i]
        if (!n) continue
        const c = base[i] as THREE.Color
        if (inSet(n.slug)) {
          lit.copy(c)
          // The one being looked at, and what it touches, brighten rather than
          // merely staying put — otherwise "lit" is only the absence of
          // dimming and the focus has no centre.
          if (slug) lit.lerp(white, slug === n.slug ? 0.45 : 0.16)
        } else {
          // Mixed toward the ground rather than made transparent: transparency
          // on an instanced mesh means sorting every instance every frame, and
          // this reads the same for one buffer upload.
          lit.copy(c).lerp(palette.bg, 0.8)
        }
        nodes.setColorAt(i, lit)
        glowCol.set([lit.r, lit.g, lit.b], i * 3)
      }
      if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true
      glowGeometry.getAttribute('color').needsUpdate = true

      // The orphans dim with everything else, but never below legible: they
      // are the finding, and a focus somewhere else must not erase them.
      for (let i = 0; i < adrift.length; i += 1) {
        const n = adrift[i]
        if (!n) continue
        lit.copy(adriftColour)
        if (slug && !inSet(n.slug)) lit.lerp(palette.bg, 0.55)
        orphans.setColorAt(i, lit)
      }
      if (orphans.instanceColor) orphans.instanceColor.needsUpdate = true

      riding = []
      edges.forEach((e, i) => {
        const on = inSet(e.source) && inSet(e.target)
        if (slug && on) riding.push(i)
        const ia = rowOf.get(e.source)
        const ib = rowOf.get(e.target)
        const ca = ia === undefined ? palette.muted : (base[ia] as THREE.Color)
        const cb = ib === undefined ? palette.muted : (base[ib] as THREE.Color)
        // A link inside a project is the structure; one that crosses between
        // projects is context. Equally bright, the long arcs drown the clusters.
        const across = arrange === 'clusters' && byslug.get(e.source)?.project !== byslug.get(e.target)?.project
        const k = on ? (slug ? 1.4 : across ? 0.3 : 0.9) : 0.09
        // Each segment takes the colour of the end it is nearer, so a link
        // reads as leaving one project and arriving at another.
        for (let seg = 0; seg < BOW; seg += 1) {
          const t0 = seg / BOW
          const t1 = (seg + 1) / BOW
          const o = (i * BOW + seg) * 6
          linkCol[o] = (ca.r + (cb.r - ca.r) * t0) * k
          linkCol[o + 1] = (ca.g + (cb.g - ca.g) * t0) * k
          linkCol[o + 2] = (ca.b + (cb.b - ca.b) * t0) * k
          linkCol[o + 3] = (ca.r + (cb.r - ca.r) * t1) * k
          linkCol[o + 4] = (ca.g + (cb.g - ca.g) * t1) * k
          linkCol[o + 5] = (ca.b + (cb.b - ca.b) * t1) * k
        }
      })
      linkGeometry.getAttribute('color').needsUpdate = true

      riding = riding.slice(0, BEAMS)
      beams.visible = riding.length > 0
      for (let i = 0; i < riding.length; i += 1) {
        const e = edges[riding[i] as number]
        const ia = e ? rowOf.get(e.source) : undefined
        const c = ia === undefined ? palette.accent : (base[ia] as THREE.Color)
        beamCol.set([c.r, c.g, c.b], i * 3)
        beamSize[i] = 5.5
      }
      for (let i = riding.length; i < BEAMS; i += 1) beamSize[i] = 0
      beamGeometry.getAttribute('color').needsUpdate = true
      beamGeometry.getAttribute('size').needsUpdate = true
    }
    paintFocus(null)

    // ---- interaction ---------------------------------------------------

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let hovering: string | null = null
    let inside = false
    /** How far the pointer travelled while held, so a drag is not a click. */
    let travelled = 0
    let last: { x: number; y: number } | null = null
    /** Touch has to behave differently, and a click event does not carry it. */
    let touch = false

    const onPointerMove = (event: PointerEvent) => {
      aim(event)
      inside = true
      if (last) {
        travelled += Math.hypot(event.clientX - last.x, event.clientY - last.y)
        last = { x: event.clientX, y: event.clientY }
      }
    }
    const onPointerLeave = () => {
      inside = false
      if (hovering) {
        hovering = null
        onHoverRef.current(null)
      }
      controls.autoRotate = !motion.matches
    }
    /** Where the pointer is, in the -1..1 space the raycaster wants. */
    const aim = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      // Read from whatever is actually being used right now, not from whatever
      // was used first: a tablet with a trackpad gets both, and a stale flag
      // means either the two-tap rule or the hover stops working.
      touch = event.pointerType === 'touch'
    }
    /** Both meshes, because the entries joined to nothing are pickable too. */
    const under = (): string | null => {
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects([nodes, orphans], false)[0]
      if (!hit || hit.instanceId === undefined) return null
      const offset = hit.object === orphans ? linked.length : 0
      return slugAt[hit.instanceId + offset] ?? null
    }

    const onPointerDown = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY }
      travelled = 0
      // A finger produces no pointermove before it lands, so without this the
      // hover state a tap reads is whatever the last mouse left behind —
      // which on a phone is nothing at all, and the tap did nothing.
      aim(event)
    }
    const onPointerUp = (event: PointerEvent) => {
      const dragged = travelled > 5
      last = null
      if (dragged) return
      aim(event)
      const slug = under()
      if (!slug) return
      // A drag that happens to end over a node is a drag — the flat map has
      // the same rule, and here it matters more because orbiting sweeps the
      // pointer across dozens of nodes on the way.
      //
      // And on a touch screen the gesture that reveals a node IS the gesture
      // that opens it, so the first tap reads it into the hover card and
      // only a second one follows the link. Same rule as the flat map, for
      // the same reason: there is no hover to separate the two.
      if (touch && focusedRef.current !== slug) {
        hovering = slug
        onHoverRef.current(slug)
        return
      }
      open(slug)
    }
    /**
     * Double-click to come home.
     *
     * Zooming toward the cursor moves the orbit target with it, which is the
     * point — but it also means a few wheel ticks into a corner of the shell
     * leaves no obvious way back, and the scene had no reset at all. The flat
     * map has bound this to double-click since it was built; same gesture
     * here, and the camera eases rather than cuts so it is clear what
     * happened.
     */
    let homing = 0
    const goHome = () => {
      homing = performance.now()
    }

    const noMenu = (event: Event) => event.preventDefault()

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('contextmenu', noMenu)
    canvas.addEventListener('dblclick', goHome)

    // ---- theme ---------------------------------------------------------

    /**
     * The flat map gets the light/dark swap for nothing, because its colours
     * ARE the custom properties. A canvas has to be told, and the only signal
     * next-themes gives is the class it writes on <html>.
     */
    const repaint = () => {
      palette = readPalette()
      scene.background = palette.bg.clone()
      if (scene.fog) (scene.fog as THREE.Fog).color = palette.bg.clone()
      base = linked.map((n) => colourOf(n))
      adriftColour.copy(palette.muted)
      for (const [m, op] of [
        [glowMat, palette.dark ? 0.5 : 0.16],
        [worldMat, palette.dark ? 0.22 : 0.1],
        [dustMat, palette.dark ? 0.45 : 0.22],
        [beamMat, palette.dark ? 0.95 : 0.7],
      ] as [THREE.ShaderMaterial, number][]) {
        m.blending = palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending
        m.uniforms.opacity!.value = op
        m.needsUpdate = true
      }
      for (let i = 0; i < dustN; i += 1) {
        dustCol.set([palette.muted.r, palette.muted.g, palette.muted.b], i * 3)
      }
      dustGeometry.getAttribute('color').needsUpdate = true
      linkMat.opacity = palette.dark ? 0.55 : 0.5
      key.intensity = palette.dark ? 1.35 : 1.9
      rim.intensity = palette.dark ? 0.85 : 0.45
      rim.color.set(palette.accent.getHex())
      ambient.intensity = palette.dark ? 0.6 : 1
      gapMat.color.set(palette.danger.getHex())
      ringMat.color.set(palette.danger.getHex())
      paintFocus(focusedRef.current)
    }
    const themeWatch = new MutationObserver(repaint)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    // ---- titles --------------------------------------------------------

    /**
     * Which titles to draw, chosen so that none lands on another.
     *
     * Same rule as the flat map — by importance, skipped on collision — with
     * depth folded into the ordering, because in three dimensions the nearest
     * label is the one that should win the space.
     *
     * They are HTML, and they are written straight to the DOM rather than
     * through React. Both of those are deliberate. HTML is what makes them a
     * constant size on screen at any camera distance and legible at a contrast
     * the stylesheet already measured — drawing them into the scene would
     * reintroduce the two bugs the flat map had, 3px text on a phone and
     * grey-on-white at 3.76:1. And writing them directly is what stops a
     * slowly rotating camera committing a React render fifteen times a second
     * for as long as the tab is open.
     */
    /** What each world is called, which is not the same as its key. */
    const titleOf = new Map(graph.entities.map((e) => [e.key, e.title]))
    const pool: HTMLSpanElement[] = []
    const worldPool: HTMLSpanElement[] = []
    const projected = new THREE.Vector3()

    /**
     * The name of each world, floating where its members settled.
     *
     * Deliberately large and dim, sitting behind the titles rather than
     * competing with them — the job a constellation name does on a star chart.
     * It is the only place the entity is written down, and without it the
     * coloured regions are a mood rather than a fact.
     */
    const drawWorlds = (w: number, h: number) => {
      groups.forEach((world, i) => {
        projected.set(world.x, world.y, world.z).project(camera)
        let span = worldPool[i]
        if (!span) {
          span = document.createElement('span')
          span.className =
            'absolute top-0 left-0 whitespace-nowrap text-[0.9375rem] font-semibold uppercase leading-none tracking-[0.22em]'
          overlay.appendChild(span)
          worldPool[i] = span
        }
        if (projected.z <= -1 || projected.z >= 1) {
          span.style.display = 'none'
          return
        }
        const name = titleOf.get(world.key) ?? world.key
        if (span.textContent !== name) span.textContent = name
        span.style.color = worldInk(world.key)
        // Knocked out of the ground, like the titles — a coloured word over a
        // coloured haze is the one place on this map contrast can vanish.
        span.style.textShadow = '0 0 6px var(--bg), 0 0 12px var(--bg)'
        // Out of the way the moment anything is being looked at.
        const spot = spotRef.current
        const dimmed =
          Boolean(focusedRef.current) ||
          Boolean(spot && !(spot.kind === grouping && spot.key === world.key))
        span.style.opacity = dimmed ? '0.25' : '0.72'
        span.style.transform = `translate3d(${Math.round((projected.x * 0.5 + 0.5) * w)}px, ${Math.round((-projected.y * 0.5 + 0.5) * h)}px, 0) translate(-50%, -50%)`
        span.style.display = ''
      })
    }

    const drawLabels = () => {
      const slug = focusedRef.current
      const near = slug ? neighbours.get(slug) : null
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      drawWorlds(w, h)

      /**
       * Nothing is named until you ask.
       *
       * The at-rest pass drew about twenty-eight hub titles permanently, which
       * is a wall of text laid over the thing it is labelling — and on a map
       * whose subject is the connections, the text was the loudest layer on
       * screen. Hover names what you are pointing at and its neighbours, and
       * that is the only time a title appears. The world names stay: three or
       * four words for the whole picture is not the same as a label per dot.
       */
      if (!slug) {
        for (const span of pool) span.style.display = 'none'
        return
      }

      /**
       * An entry joined to nothing is named too (CAIRN-349).
       *
       * Only the cloud was searched, so hovering one of the disc's entries —
       * about half the corpus — lit it and named nothing beside it. It has no
       * neighbours by definition, so it is the only title to place; its
       * position comes from the same layout the disc's mesh was placed from,
       * and projects the same way.
       */
      const held = byslug.get(slug)
      const among = held && held.degree === 0 ? [held] : linked
      const candidates: { node: (typeof linked)[number]; x: number; y: number; z: number }[] = []
      for (const n of among) {
        if (!(n.slug === slug || (near?.has(n.slug) ?? false))) continue
        const p = place.at.get(n.slug)
        if (!p) continue
        projected.set(p.x, p.y, p.z).project(camera)
        if (projected.z <= -1 || projected.z >= 1) continue
        candidates.push({
          node: n,
          x: (projected.x * 0.5 + 0.5) * w,
          y: (-projected.y * 0.5 + 0.5) * h - 24,
          z: projected.z,
        })
      }
      candidates.sort((a, b) =>
        a.node.slug === slug
          ? -1
          : b.node.slug === slug
            ? 1
            : a.z - b.z || b.node.degree - a.node.degree,
      )

      const placed: { x: number; y: number; w: number; h: number }[] = []
      let used = 0
      for (const c of candidates) {
        if (used >= LABEL_CAP) break
        const text = c.node.title.length > 38 ? `${c.node.title.slice(0, 37)}…` : c.node.title
        const bw = text.length * 5.7 + 10
        const bh = 15
        const bx = c.x - bw / 2
        if (bx + bw < 0 || bx > w || c.y + bh < 0 || c.y > h) continue
        if (placed.some((b) => bx < b.x + b.w && bx + bw > b.x && c.y < b.y + b.h && c.y + bh > b.y))
          continue
        placed.push({ x: bx, y: c.y, w: bw, h: bh })

        let span = pool[used]
        if (!span) {
          span = document.createElement('span')
          span.className =
            'text-fg-muted absolute top-0 left-0 whitespace-nowrap text-meta leading-none'
          // Three stacked shadows in the ground colour, which is how a knockout
          // is done without a second element behind every title.
          span.style.textShadow = '0 0 3px var(--bg), 0 0 3px var(--bg), 0 0 7px var(--bg)'
          overlay.appendChild(span)
          pool[used] = span
        }
        if (span.textContent !== text) span.textContent = text
        span.style.transform = `translate3d(${Math.round(c.x)}px, ${Math.round(c.y)}px, 0) translateX(-50%)`
        span.style.opacity = slug && c.node.slug !== slug ? '0.75' : '1'
        span.style.display = ''
        used += 1
      }
      for (let i = used; i < pool.length; i += 1) {
        const span = pool[i]
        if (span) span.style.display = 'none'
      }
    }

    // ---- the loop ------------------------------------------------------

    const resize = () => {
      const w = element.clientWidth || 1
      const h = element.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // A narrow window needs the camera further back than a wide one for the
      // same scene. Only ever pushes out, and only before the reader has
      // taken the controls — moving the camera under someone mid-orbit is
      // worse than a slightly tight frame.
      if (!touched) {
        const want = fitFor(camera.aspect)
        camera.position.copy(TARGET).addScaledVector(HOME.clone().normalize(), want)
        controls.maxDistance = want * 3
      }
      // What the renderer passes its own PointsMaterial. Left at a constant
      // the glow is sized for one window height and wrong in every other.
      for (const m of [glowMat, worldMat, dustMat, beamMat]) m.uniforms.scale!.value = h * 0.5
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()

    const _home = new THREE.Vector3()
    let raf = 0
    let frame = 0
    let alive = true
    let lastFocus: string | null = null
    let lastSpot: Spotlight = null
    const born = performance.now()
    /**
     * The camera arrives rather than cutting.
     *
     * A second and a bit of easing in from further out. It costs nothing, it
     * tells the reader the thing has depth before they touch it, and it is
     * skipped entirely under prefers-reduced-motion.
     */
    const INTRO = motion.matches || resumed ? 0 : 1400

    const tick = () => {
      if (!alive) return
      raf = requestAnimationFrame(tick)
      // Easing home, if a double-click asked for it. Driven before
      // controls.update() so its damping smooths the last of the travel
      // rather than fighting it.
      if (homing) {
        const k = Math.min(1, (performance.now() - homing) / 700)
        const e = 1 - (1 - k) ** 3
        controls.target.lerp(TARGET, e * 0.35)
        camera.position.lerp(_home.copy(TARGET).add(HOME), e * 0.35)
        if (k >= 1) homing = 0
      }

      const age = performance.now() - born
      if (INTRO > 0 && age < INTRO && !touched) {
        // Along the view axis from the target, and inside maxDistance —
        // pushed past it, OrbitControls clamps the camera back every frame
        // and the arrival stutters against its own limit.
        const k = 1 - (1 - age / INTRO) ** 3
        const from = camera.position.distanceTo(TARGET)
        const want = reach * (1 + 0.55 * (1 - k))
        camera.position
          .sub(TARGET)
          .multiplyScalar((want || from) / (from || 1))
          .add(TARGET)
      }
      if (halt) controls.dampingFactor = 1
      controls.update()
      if (halt) {
        controls.dampingFactor = DAMPING
        halt = false
      }
      /**
       * Because `controls.update()` does not do it.
       *
       * It moves `camera.position` and calls `lookAt`, both of which touch
       * only the local transform — the `updateMatrixWorld()` calls in
       * OrbitControls live in the `zoomToCursor` branch, which this scene does
       * not use. `camera.matrixWorld` is otherwise refreshed by the renderer,
       * and that happens at the BOTTOM of this function.
       *
       * So everything below that reads the camera — the raycast for the hover
       * pick, and `project()` for every title — would be working from where
       * the camera was on the previous frame, one frame behind what is then
       * drawn. With `autoRotate` on, the camera is never still, so that is not
       * an edge case during a drag: it is every frame the tab is open, and it
       * shows up as titles that float slightly off their nodes and a hover
       * target that does not quite match what is under the cursor.
       *
       * The renderer sees the matrix is already current and skips its own.
       */
      camera.updateMatrixWorld()

      // Not while a finger is on the glass. Picking on touch-move would light
      // every node an orbit gesture passed over, and by the time the finger
      // lifted the node under it would already be the focused one — which is
      // exactly the state the two-tap rule reads as "you have seen this, now
      // open it". The first tap would open.
      if (inside && !touch) {
        const slug = under()
        if (slug !== hovering) {
          hovering = slug
          onHoverRef.current(slug)
          canvas.style.cursor = slug ? 'pointer' : ''
          /**
           * Nothing moves while you are reading it.
           *
           * The auto-rotation is there to say the picture has depth before
           * anybody touches it. Once a node is under the cursor that job is
           * done, and the rotation becomes something actively working against
           * the reader: the hover card names an entry, the neighbourhood is
           * lit, and the whole thing is sliding out from under the pointer.
           */
          controls.autoRotate = slug === null && !motion.matches
          // Stop dead on the way in; coasting away is fine on the way out.
          if (slug !== null) halt = true
        }
      }

      if (focusedRef.current !== lastFocus || spotRef.current !== lastSpot) {
        lastFocus = focusedRef.current
        lastSpot = spotRef.current
        paintFocus(lastFocus)
      }

      // The titles are the expensive part of a frame, not the scene. Re-placed
      // every third frame: the camera moves slowly enough that nobody can see
      // the difference, and it takes the projection and the collision pass off
      // two frames in three.
      // The beams ride their links. One pass over at most 96 points, and only
      // while something is being looked at.
      if (riding.length > 0) {
        const t = (performance.now() % 1100) / 1100
        for (let i = 0; i < riding.length; i += 1) {
          curveOf(riding[i] as number, t, pt)
          beamPos.set([pt.x, pt.y, pt.z], i * 3)
        }
        beamGeometry.getAttribute('position').needsUpdate = true
      }

      frame += 1
      if (frame % 3 === 0) drawLabels()

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      kept.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
        touched,
      }
      alive = false
      cancelAnimationFrame(raf)
      observer.disconnect()
      themeWatch.disconnect()
      motion.removeEventListener('change', onMotionChange)
      controls.dispose()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('contextmenu', noMenu)
      canvas.removeEventListener('dblclick', goHome)
      for (const span of [...pool, ...worldPool]) span.remove()
      // A WebGL context is not collected on unmount and the browser keeps only
      // a handful, so walking between the map and an entry a dozen times would
      // otherwise silently lose the oldest.
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        mesh.geometry?.dispose()
        const m = mesh.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else if (m) (m as THREE.Material).dispose()
      })
      dot.dispose()
      haze.dispose()
      ringTex.dispose()
      renderer.dispose()
      canvas.remove()
    }
  }, [graph, place, groups, grouping, colourBy, arrange, neighbours, open])

  return (
    <div className="absolute inset-0">
      <div ref={host} className="h-full w-full cursor-grab active:cursor-grabbing" />
      <div ref={layer} className="pointer-events-none absolute inset-0 overflow-hidden" />
    </div>
  )
}

export default GraphScene
