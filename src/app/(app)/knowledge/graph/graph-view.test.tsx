import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView } from './graph-view'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The shell over the two renderers.
 *
 * What is asserted here is the part that must not depend on which one is
 * mounted: the legend, the title bar, and the rule that a browser which cannot
 * run WebGL is never offered it. A static render has no canvas, so this is
 * also exactly the no-WebGL case — which is the one worth pinning, because it
 * is the one nobody will look at by hand.
 */

const graph = (over: Partial<KnowledgeGraph> = {}): KnowledgeGraph => ({
  nodes: [
    {
      slug: 'alpha',
      title: 'Alpha',
      project: 'CAIRN',
      entity: null,
      degree: 1,
      excerpt: 'What alpha says first.',
      island: 0,
      x: 10,
      y: 10,
    },
    { slug: 'beta', title: 'Beta', project: null, entity: null, degree: 1, island: 0, x: 60, y: 30 },
    { slug: 'lonely', title: 'Lonely', project: null, entity: null, degree: 0, island: -1, x: 0, y: 200 },
  ],
  entities: [],
  edges: [{ source: 'alpha', target: 'beta' }],
  missing: [{ slug: 'never-written', from: ['alpha'], x: 40, y: 80 }],
  islands: [2],
  width: 100,
  height: 200,
  isolatedFrom: 2,
  stats: {
    entries: 3,
    withReferences: 2,
    references: 2,
    resolved: 1,
    dangling: 1,
    isolated: 1,
    islands: 1,
  },
  ...over,
})

describe('the map shell', () => {
  it('says what every mark on it means, over either renderer', () => {
    // "What are the dotted red circles?" was asked after ten minutes of
    // looking at this, and the answer only existed in a caption below the
    // frame. A map whose key is somewhere else is a map with no key.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('never written')
    expect(html).toContain('more links')
    expect(html).toContain('joined to nothing')
  })

  it('draws the flat map where WebGL is not available', () => {
    // No canvas in a static render, so this is the fallback path. It has to
    // produce the actual map, not an empty frame waiting for a scene that is
    // never going to mount.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('<svg')
    expect(html).toContain('/knowledge/alpha')
    expect(html).toContain('aria-label="Zoom in"')
  })

  it('does not offer a view it cannot draw', () => {
    // A toggle to a renderer this browser cannot run is worse than no toggle:
    // it is a control that produces a black rectangle.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).not.toContain('How to draw the map')
    expect(html).not.toContain('Spatial')
  })

  it('keeps the corner bar for help, and draws no card until something is hovered', () => {
    // CAIRN-349: the bar used to carry the hovered title as well, a long way
    // from the pointer. Now it only says how to use the map; the card is in
    // the markup but hidden, so there is one element to move rather than one
    // to mount on every hover.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toMatch(/data-hover-card="true"[^>]*class="[^"]*\bhidden\b/)
    expect(html).not.toContain('What alpha says first.')
    expect(html).toContain('aria-live="polite"')
  })

  it('describes the gestures that exist on the device being used', () => {
    // The bar read "Hover a node · scroll to zoom" on a phone, naming two
    // gestures that do not exist there and omitting the one that does.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('drag to pan')
    expect(html).toContain('pinch to zoom')
  })

  it('draws an empty corpus without falling over', () => {
    const html = renderToStaticMarkup(
      <GraphView graph={graph({ nodes: [], edges: [], missing: [], isolatedFrom: 0 })} />,
    )

    expect(html).toContain('<svg')
    expect(html).not.toContain('NaN')
  })

  it('names a world the way the rest of the app names it', () => {
    // The map had only the entity KEY, so it wrote "dispofi" where settings
    // and the knowledge list both say "Dispofi". A key identifies; a title is
    // what somebody chose to call the thing. The scene is client-only so this
    // asserts the shell passes the titles down rather than the rendering.
    const g = graph({
      entities: [
        { key: 'dispofi', title: 'Dispofi' },
        { key: 'tribe', title: 'Tribe' },
      ],
    })

    expect(g.entities.map((e) => e.title)).toEqual(['Dispofi', 'Tribe'])
    // and the shell renders without them, because most installs have none
    const html = renderToStaticMarkup(<GraphView graph={graph({ entities: [] })} />)
    expect(html).toContain('<svg')
  })

  it('offers the spotlight, and starts with everything lit', () => {
    // A map that opens blacked out looks broken, so "Everything" has to be
    // the resting state and the selected one.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('Light up one project or entity')
    expect(html).toContain('Everything')
  })

  it('offers only the projects and worlds that are on the map', () => {
    // CAIRN has no knowledge in this fixture, so it must not be offered —
    // picking it would black the map out with no explanation.
    const html = renderToStaticMarkup(
      <GraphView
        graph={graph({
          nodes: [
            { slug: 'a', title: 'A', project: 'BB', entity: 'tribe', degree: 1, island: 0, x: 0, y: 0 },
            { slug: 'b', title: 'B', project: null, entity: null, degree: 0, island: -1, x: 0, y: 9 },
          ],
          entities: [
            { key: 'tribe', title: 'Tribe' },
            { key: 'nowhere', title: 'Nowhere' },
          ],
          edges: [],
          missing: [],
          isolatedFrom: 1,
        })}
      />,
    )

    expect(html).toContain('BB')
    expect(html).toContain('Tribe')
    expect(html).not.toContain('Nowhere')
  })
})

/**
 * The card at the pointer (CAIRN-349), driven the way a mouse drives it: the
 * container hears where the pointer is, a node hears that it is entered. No
 * layout in jsdom, so the sizes the placement reads are stated outright.
 */
describe('the hover card', () => {
  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // The flat map sizes its titles from a ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    // And a press captures the pointer so a pan can leave the map.
    Object.assign(Element.prototype, {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
    })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    for (const name of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
      delete (Element.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  const mount = () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<GraphView graph={graph()} />))
    const frame = host.firstElementChild as HTMLDivElement
    const card = host.querySelector('[data-hover-card]') as HTMLDivElement
    Object.defineProperty(frame, 'clientWidth', { value: 400 })
    Object.defineProperty(frame, 'clientHeight', { value: 300 })
    Object.defineProperty(card, 'offsetWidth', { value: 200 })
    Object.defineProperty(card, 'offsetHeight', { value: 60 })
    const point = (type: string, target: Element, x: number, y: number) =>
      act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
      })
    const unmount = () => {
      act(() => root.unmount())
      host.remove()
    }
    return { host, frame, card, point, unmount }
  }

  it('says what is hovered, next to the pointer, and tells a screen reader', () => {
    const { host, frame, card, point, unmount } = mount()
    const alpha = host.querySelector('a[href="/knowledge/alpha"] circle') as Element

    point('pointermove', frame, 100, 80)
    point('pointerover', alpha, 100, 80)

    expect(card.className).not.toMatch(/\bhidden\b/)
    expect(card.style.visibility).toBe('')
    expect(card.textContent).toContain('Alpha')
    expect(card.textContent).toContain('1 link · CAIRN')
    expect(card.textContent).toContain('What alpha says first.')
    expect(card.style.transform).toBe('translate3d(114px, 94px, 0)')
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('Alpha · 1 link · CAIRN')
    unmount()
  })

  it('flips to stay inside the map near its far corner', () => {
    const { host, frame, card, point, unmount } = mount()
    const alpha = host.querySelector('a[href="/knowledge/alpha"] circle') as Element

    point('pointermove', frame, 390, 290)
    point('pointerover', alpha, 390, 290)

    expect(card.style.transform).toBe(`translate3d(${390 - 14 - 200}px, ${290 - 14 - 60}px, 0)`)
    unmount()
  })

  it('anchors at a tap on a touch screen, and does not chase a dragging finger', () => {
    // No hover on glass: the first tap focuses the node, so the tap is where
    // the card goes. A finger dragging to pan is not pointing at anything.
    const { host, frame, card, unmount } = mount()
    const alpha = host.querySelector('a[href="/knowledge/alpha"] circle') as Element
    const touch = (type: string, target: Element, x: number, y: number) =>
      act(() => {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
        Object.defineProperty(event, 'pointerType', { value: 'touch' })
        target.dispatchEvent(event)
      })

    touch('pointerdown', alpha, 60, 40)
    touch('pointerover', alpha, 60, 40)
    touch('pointerup', alpha, 62, 41)
    expect(card.textContent).toContain('Alpha')
    // Where the tap lifted, placed on the next frame.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        expect(card.style.transform).toBe('translate3d(76px, 55px, 0)')
        touch('pointermove', frame, 300, 200)
        requestAnimationFrame(() => {
          expect(card.style.transform).toBe('translate3d(76px, 55px, 0)')
          unmount()
          resolve()
        })
      })
    })
  })

  it('names a reference to nothing as never written', () => {
    const { host, frame, card, point, unmount } = mount()
    const gap = host.querySelector('circle[stroke-dasharray]') as Element

    point('pointermove', frame, 50, 50)
    point('pointerover', gap, 50, 50)

    expect(card.textContent).toContain('never-written')
    expect(card.textContent).toContain('never written, referenced by 1')
    unmount()
  })
})
