import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The app layout renders `<main className="… overflow-hidden">`, so the shell
 * never scrolls and every page has to own its own scrolling. A page that
 * forgets does not overflow visibly — it simply clips, with no scrollbar and no
 * error, and the bottom of it is gone.
 *
 * Settings shipped that way and nobody noticed until the Entities section made
 * it taller than a viewport; /api-docs had the same hole, with `min-h-dvh`
 * guaranteeing the content was at least as tall as the area clipping it.
 *
 * Layout cannot be measured without a browser, so this checks the one thing
 * that is checkable from source: every page declares a scroll container.
 */
describe('every page scrolls itself', () => {
  const root = join(process.cwd(), 'src/app/(app)')

  const pages = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return pages(join(dir, entry.name))
      return entry.name === 'page.tsx' ? [join(dir, entry.name)] : []
    })

  it.each(pages(root).map((p) => [p.slice(root.length + 1), p]))(
    '%s',
    (_label, path) => {
      const source = readFileSync(path, 'utf8')
      expect(source).toMatch(/overflow-(y-)?auto/)
    },
  )
})
