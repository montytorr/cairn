import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A CSS trap that cost time twice in one day.
 *
 * Setting ONE overflow axis to `auto` forces the other from `visible` to
 * `auto`. `overflow-x-auto` therefore makes an element a scroll container in
 * *both* directions, and it then clips any absolutely positioned descendant
 * lying outside its box.
 *
 * That is why the bulk bar's Status and Priority menus did nothing: each
 * rendered at 168x195 some 191px above a bar whose own box was 40px tall, and
 * was clipped out of existence. It is also why an earlier mobile check passed
 * while the list was plainly scrolling sideways — the page did not scroll, an
 * inner container did.
 *
 * Clipping cannot be observed without layout, and jsdom has none, so this
 * guards the one thing that is checkable: the floating bar that opens those
 * menus must not carry a scroll utility. Deliberately narrow — a broader sweep
 * flagged the legitimate scroll areas *inside* menus and taught nothing.
 */
describe('the bulk bar is not a scroll container', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/projects/[key]/bulk-bar.tsx'),
    'utf8',
  )

  // The bar itself, identified by its drop shadow.
  const barClasses = source
    .split('\n')
    .filter((line) => line.includes('shadow-[0_12px_40px') && line.includes('className'))

  it('has a bar to check', () => {
    expect(barClasses).toHaveLength(1)
  })

  it('carries no scroll utility, which would clip the menus it opens', () => {
    expect(barClasses[0]).not.toMatch(/overflow-[xy]?-?(auto|scroll)/)
  })

  it('still opens its menus above itself, which is what made clipping fatal', () => {
    expect(source).toMatch(/absolute bottom-\[\d+px\]/)
  })
})
