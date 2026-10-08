import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The interface is set in three sizes (--fs-ui, --fs-meta, --fs-label in
 * globals.css): 14/15px, 13/13.5px, and a 12px uppercase, tracked micro
 * label. Nothing smaller than `meta` may carry words unless it is that label.
 *
 * What goes wrong is a one-off `text-[0.6875rem]` written for a tight row. It
 * looks fine in review and is the reason a screenshot of the product shows
 * grey text nobody can read. So an arbitrary rem size below the meta floor
 * fails here, wherever it is written.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })

const FLOOR_REM = 0.7222

describe('interface type scale', () => {
  const findings: string[] = []
  for (const file of walk('src')) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/text-\[(\d*\.?\d+)rem\]/g)) {
      if (Number(match[1]) >= FLOOR_REM - 0.0005) continue
      findings.push(`${file}: ${match[0]}`)
    }
    for (const match of source.matchAll(/text-\[(\d+)px\]/g)) {
      if (Number(match[1]) >= 13) continue
      findings.push(`${file}: ${match[0]}`)
    }
  }

  it('sets no arbitrary size below the 13px floor', () => {
    expect(findings).toEqual([])
  })

  it('declares the three sizes, with the interface size growing at 768', () => {
    const css = readFileSync('src/app/globals.css', 'utf8')
    expect(css).toMatch(/--fs-ui:\s*0\.7778rem/)
    expect(css).toMatch(/--fs-meta:\s*0\.7222rem/)
    expect(css).toMatch(/min-width:\s*768px\)\s*\{\s*:root\s*\{\s*--fs-ui:\s*0\.8333rem/)
  })

  it('keeps micro labels uppercase', () => {
    const lonely: string[] = []
    for (const file of walk('src')) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(['"`])((?:(?!\1)[^\n])*?\btext-label\b(?:(?!\1)[^\n])*)\1/g)) {
        if (!/\buppercase\b/.test(match[2] ?? '')) lonely.push(`${file}: ${match[2]}`)
      }
    }
    expect(lonely).toEqual([])
  })
})
