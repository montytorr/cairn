import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every write from the browser goes through `mutate` (or `useMutate`, which
 * also shows the failure).
 *
 * Hand-rolled, about half of them were wrong in one of four ways: no check on
 * the response at all, a silent rollback of optimistic state, reading
 * `json.error.message` when the envelope carries `error` as a string, or —
 * true of every single one — no try/catch, so a dropped connection left the
 * editor stuck on "Saving…" and dragged cards in lanes they never reached.
 *
 * The helper cannot force a component to show the message it returns. What it
 * can do is make sure nobody writes the raw version again.
 */
describe('writes go through the mutate helper', () => {
  const roots = [join(process.cwd(), 'src/app/(app)'), join(process.cwd(), 'src/components')]

  /** Each with the reason it is allowed to stay hand-rolled. */
  const EXEMPT: Record<string, string> = {
    'knowledge/[slug]/knowledge-detail.tsx':
      'its own patch() throws, and every caller catches and renders the message',
    'user-menu.tsx':
      'sign-out ignores the response on purpose — the local session is gone either way',
    'settings/password-section.tsx':
      'already try/catches and has its own error line',
  }

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return files(path)
      return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : []
    })

  const offenders = roots
    .flatMap(files)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    // A mutating fetch, written out by hand.
    .filter(({ source }) => /fetch\([^)]*\{[^}]*method: '(POST|PATCH|PUT|DELETE)'/s.test(source))
    .filter(({ source }) => !source.includes("from '@/lib/api/mutate'"))
    .filter(({ source }) => !source.includes("from '@/lib/api/use-mutate'"))
    .map(({ path }) => relative(join(process.cwd(), 'src'), path))
    .filter((rel) => !Object.keys(EXEMPT).some((allowed) => rel.endsWith(allowed)))

  it('no component writes with a raw fetch', () => {
    expect(offenders).toEqual([])
  })
})
