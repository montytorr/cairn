import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The board toolbar opens five filter popovers. See
 * src/lib/overflow-guard.test.ts: setting one overflow axis to `auto` forces
 * the other from `visible` to `auto`, which is exactly what clipped the bulk
 * bar's own menus out of existence (CAIRN, 2026-09-10/11). The toolbar row
 * must wrap rather than scroll, so it never becomes that scroll container.
 */
describe('the board toolbar is not a scroll container', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/board/board-toolbar.tsx'),
    'utf8',
  )

  const toolbarRow = source
    .split('\n')
    .filter((line) => line.includes('flex-wrap') && line.includes('className'))

  it('has a toolbar row to check', () => {
    expect(toolbarRow.length).toBeGreaterThan(0)
  })

  it('carries no scroll utility, which would clip the filter menus it opens', () => {
    for (const line of toolbarRow) {
      expect(line).not.toMatch(/overflow-[xy]?-?(auto|scroll)/)
    }
  })

  it('still opens its menus with an absolute popover', () => {
    // Unit-agnostic on purpose: what matters is that the popover is placed
    // outside the bar, not whether the offset is written in px or rem. This
    // assertion has now broken twice on details it never meant to pin — first
    // a drop shadow, then the switch to rem — and a guard that cries wolf is
    // one somebody eventually deletes.
    const menu = readFileSync(join(process.cwd(), 'src/components/filter-menu.tsx'), 'utf8')
    expect(source).toContain("from '@/components/filter-menu'")
    expect(menu).toMatch(/absolute top-\[[\d.]+(px|rem)\]/)
  })
})
