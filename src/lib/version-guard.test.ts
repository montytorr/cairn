import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'

/**
 * The CLI carries its own version number, because it is copied onto machines
 * rather than installed from a registry — there is no package.json next to the
 * copy in /usr/local/bin to read it from.
 *
 * That makes it exactly the kind of constant that goes stale silently. A CLI
 * three days out of date was found still writing under the wrong identity,
 * long after the fix had shipped, and nothing anywhere said so.
 */
describe('the CLI reports the version it was released as', () => {
  it('matches package.json', () => {
    const source = readFileSync(join(process.cwd(), 'cli/cairn.mjs'), 'utf8')
    const declared = /const VERSION = '([^']+)'/.exec(source)?.[1]
    expect(declared, 'cli/cairn.mjs must declare a VERSION').toBeDefined()
    expect(declared).toBe(pkg.version)
  })

  it('is a semantic version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
