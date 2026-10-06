import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The interface sets no italic. Labels, empty states, pills and captions say
 * what they are with colour, weight and size; a slant is kept for the one
 * place it carries meaning, emphasis someone wrote in a body, a note or a
 * knowledge entry. Rendered markdown and the editor get it from the browser's
 * own `em` rule, in the platform's sans and mono, which both draw a true
 * italic.
 *
 * The other way this goes wrong is a face that has no italic downloaded:
 * next/font fetches only the upright unless `style` asks for 'italic', and the
 * browser then slants the upright itself. So prose must never be set in such
 * a face.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })

// Comments explain past italics ("a grey italic word") and must not count.
// The `//` form skips URLs inside strings, which only ever hides code, never
// invents a finding.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`\\])\/\/[^\n]*/g, '')

/** An `italic` utility, bare or behind variants (`sm:italic`, `[&_p]:italic`). */
const UTILITY = /(?<![\w-])(?:[\w&[\]_:-]*:)?italic(?![\w-])/g
/** Inline styles, in JSX or in an ImageResponse. */
const INLINE = /fontStyle\s*:\s*['"](?:italic|oblique)/g
/** Elements the browser slants by default. */
const ELEMENT = /<(?:em|i|cite|dfn|var|address)(?=[\s>])/g

const findings = (source: string) =>
  [UTILITY, INLINE, ELEMENT].flatMap((pattern) =>
    [...stripComments(source).matchAll(pattern)].map((m) => m[0]),
  )

describe('italic in the interface', () => {
  it('recognises each form it looks for', () => {
    // A guard on the guard: a pattern that matches nothing passes forever.
    expect(findings('<p className="text-fg-subtle italic">x</p>')).toEqual(['italic'])
    expect(findings("cn('a', open && 'sm:italic')")).toEqual(['sm:italic'])
    expect(findings("style={{ fontStyle: 'oblique' }}")).toHaveLength(1)
    expect(findings('<em>x</em> <i className="a">y</i>')).toHaveLength(2)
    expect(findings("/* a grey italic word */ import Italic from '@tiptap/extension-italic'")).toEqual([])
  })

  it('is set nowhere in a component', () => {
    const found = walk('src').flatMap((file) =>
      findings(readFileSync(file, 'utf8')).map((hit) => `${file}: ${hit}`),
    )
    expect(found).toEqual([])
  })

  describe('in the stylesheet', () => {
    /** Selectors whose slant is written emphasis, not decoration. */
    const PROSE = new Set(['.hljs-emphasis'])

    const css = readFileSync('src/app/globals.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const slanted = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /font-style\s*:\s*(?:italic|oblique)/.test(body ?? ''))
      .flatMap(([, selectors]) => (selectors ?? '').split(',').map((s) => s.trim()))

    it('finds the emphasis rule it allows', () => {
      expect(slanted).toContain('.hljs-emphasis')
    })

    it('slants only written emphasis', () => {
      expect(slanted.filter((selector) => !PROSE.has(selector))).toEqual([])
    })
  })

  it('never sets prose in a face downloaded without its italic', () => {
    const fonts = readFileSync('src/app/fonts.ts', 'utf8')
    const theme = readFileSync('src/app/globals.css', 'utf8')

    // Each next/font call, by the CSS variable it exposes, and whether it
    // asked for the italic.
    const uprightOnly = [...fonts.matchAll(/\w+\(\{([\s\S]*?)\}\)/g)]
      .map(([, options]) => ({
        variable: /variable:\s*['"](--[\w-]+)['"]/.exec(options ?? '')?.[1],
        italic: /style:[^\n]*['"]italic['"]/.test(options ?? ''),
      }))
      .filter((face) => face.variable && !face.italic)
      .map((face) => face.variable as string)
    expect(uprightOnly.length).toBeGreaterThan(0)

    // The Tailwind keys that resolve to one of those faces first.
    const keys = [...theme.matchAll(/^\s*--font-([a-z0-9-]+)\s*:\s*var\((--[\w-]+)\)/gm)]
      .filter(([, , variable]) => uprightOnly.includes(variable ?? ''))
      .map(([, key]) => key as string)
    expect(keys).toContain('display')

    const prose = [
      'src/components/markdown.tsx',
      'src/components/markdown-editor.tsx',
      'src/lib/editor/markdown.ts',
    ]
    const found = prose.flatMap((file) => {
      const source = stripComments(readFileSync(file, 'utf8'))
      return keys
        .filter((key) => new RegExp(`(?<![\\w-])font-${key}(?![\\w-])`).test(source))
        .map((key) => `${file}: font-${key}`)
    })
    expect(found).toEqual([])
  })
})
