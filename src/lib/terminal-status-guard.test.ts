import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Closing a task requires a resolution — the API refuses `status: done` or
 * `status: cancelled` without one. That rule is the whole reason closed tasks
 * are worth finding later, but it means every surface offering the full status
 * list has to ask for a resolution *before* it writes, or the write is dead on
 * arrival.
 *
 * Four surfaces do that. The list view did not: it fired the PATCH, took the
 * refusal, and rendered the word "refused" in 11px at the end of the row — so
 * cancelling a task from the list looked simply broken, which is how it was
 * reported.
 *
 * A component that offers every status and can write one must know what a
 * terminal status is. That is checkable from source; whether it then does the
 * right thing is not, so this is a floor rather than a proof.
 */
describe('anything that can close a task asks how it ended', () => {
  const root = join(process.cwd(), 'src/app/(app)')

  const components = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return components(path)
      return entry.name.endsWith('.tsx') ? [path] : []
    })

  const writesAStatus = (source: string) =>
    source.includes('TASK_STATUSES') && /method: 'PATCH'|patch\(/.test(source)

  const suspects = components(root).filter((p) => writesAStatus(readFileSync(p, 'utf8')))

  it('finds the surfaces that write a status', () => {
    // If this drops to zero the guard has stopped guarding anything.
    expect(suspects.length).toBeGreaterThan(0)
  })

  it.each(suspects.map((p) => [p.slice(root.length + 1), p]))('%s', (_label, path) => {
    expect(readFileSync(path, 'utf8')).toContain('isTerminal')
  })
})
