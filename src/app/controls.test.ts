import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every form control is one style (globals.css: the base layer for bare
 * elements, `.btn`, `.chip`, `.field-shell`), in two sizes. What goes wrong is
 * one-off: an h-7 on a select, a dashed disabled button, an input restyled to
 * borderless with `outline-none`, a bare native select with another font. The
 * look is checked in the CSS here, and the source is checked for the habits
 * that put a control back out of line. The rendered result is
 * `npm run audit:controls`, which needs a running instance.
 */
const css = readFileSync('src/app/globals.css', 'utf8')
const stripCss = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '')
// Comments explain past mistakes ("a bare <select>") and must not count.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`\\])\/\/[^\n]*/g, '')

const tokens = (selector: RegExp) => {
  const start = css.search(selector)
  const open = css.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  return Object.fromEntries(
    [...css.slice(open + 1, end).matchAll(/^\s*--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/gm)].map((m) => [m[1]!, m[2]!]),
  )
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const light = tokens(/^:root\s*\{/m)
const dark = { ...light, ...tokens(/^:root\.dark\s*\{/m) }

describe.each([['light', light], ['dark', dark]] as const)('%s theme controls', (_name, t) => {
  it('draws the rim of a checkbox or radio at 3:1 on every ground, since the box has nothing else to say it is a control', () => {
    const low = ['bg', 'bg-elevated', 'surface', 'surface-raised']
      .map((ground) => [ground, ratio(t['control-border']!, t[ground]!)] as const)
      .filter(([, r]) => r < 3)
      .map(([ground, r]) => `${ground}: ${r.toFixed(2)}`)
    expect(low).toEqual([])
  })

  it('keeps a text field quieter than that but still drawn: its rim is distinct from the field fill and the ground, and brightens on hover', () => {
    for (const ground of ['bg', 'bg-elevated', 'surface']) {
      expect(ratio(t['field-border']!, t[ground]!)).toBeGreaterThanOrEqual(1.25)
    }
    expect(ratio(t['field-border']!, t['field-bg']!)).toBeGreaterThanOrEqual(1.25)
    expect(ratio(t['field-border-hover']!, t['field-bg']!)).toBeGreaterThan(ratio(t['field-border']!, t['field-bg']!))
  })

  it('keeps a disabled control readable: muted text, 4.5:1 on the raised ground it is drawn on', () => {
    expect(ratio(t['fg-muted']!, t['surface-raised']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(t['fg-subtle']!, t['surface']!)).toBeGreaterThanOrEqual(4.5)
  })
})

const rule = (selector: string) => {
  const at = css.indexOf(selector)
  if (at < 0) return ''
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('control styles', () => {
  it('has two heights and no others', () => {
    expect(css).toMatch(/--control-h:\s*2\.3333rem/)
    expect(css).toMatch(/--control-h-sm:\s*2rem/)
  })

  it('draws the select itself: no native arrow, a theme chevron, room for it, an ellipsis', () => {
    const select = rule('  select {')
    expect(select).toMatch(/background-image:\s*var\(--chevron\)/)
    expect(select).toMatch(/padding-right:\s*2\.25rem/)
    expect(select).toMatch(/text-overflow:\s*ellipsis/)
    expect(css).toMatch(/select::picker-icon\s*\{\s*display:\s*none/)
    expect(css).toMatch(/-webkit-appearance:\s*none;\s*appearance:\s*none;/)
  })

  it('gives the option list the theme: the colour scheme on <html>, and a ground for options', () => {
    expect(css).toMatch(/html\s*\{\s*color-scheme:\s*light/)
    expect(css).toMatch(/html\.dark\s*\{\s*color-scheme:\s*dark/)
    expect(css).toMatch(/option,\s*optgroup\s*\{[^}]*background-color:\s*var\(--surface\)/)
  })

  it('draws every state: hover, focus, invalid, disabled, placeholder', () => {
    expect(css).toMatch(/:focus\s*\{[^}]*border-color:\s*var\(--accent\)/)
    expect(css).toMatch(/aria-invalid='true'/)
    expect(css).toMatch(/::placeholder\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/:disabled\s*\{[^}]*opacity:\s*1/)
  })

  it('never draws a disabled control dashed, dotted or faded', () => {
    const disabled = [...stripCss(css).matchAll(/[^{}]*:disabled[^{}]*\{[^}]*\}|[^{}]*\[aria-disabled='true'\][^{}]*\{[^}]*\}/g)].map((m) => m[0])
    expect(disabled.length).toBeGreaterThan(0)
    for (const block of disabled) {
      expect(block, block).not.toMatch(/dashed|dotted/)
      expect(block, block).not.toMatch(/opacity:\s*0?\.\d/)
    }
  })

  it('makes a checkbox and a radio the same box, with the accent when on', () => {
    expect(css).toMatch(/input:is\(\[type='checkbox'\], \[type='radio'\]\)\s*\{[^}]*width:\s*1\.1111rem/)
    expect(css).toMatch(/\):checked,[^{]*\{[^}]*background-color:\s*var\(--accent\)/)
  })
})

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [path] : []
  })

/** The opening tags of the controls, read with their whole attribute list. */
const openingTags = (source: string) => {
  const tags: string[] = []
  const start = /<(input|select|textarea|Input|Select|Textarea|InlineInput|Button)(?=[\s/>])/g
  for (const match of source.matchAll(start)) {
    let depth = 0
    let quote = ''
    let i = match.index! + match[0].length
    for (; i < source.length; i++) {
      const c = source[i]!
      if (quote) {
        if (c === quote && source[i - 1] !== '\\') quote = ''
      } else if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    tags.push(source.slice(match.index!, i + 1))
  }
  return tags
}

describe('control markup', () => {
  const findings: string[] = []
  let scanned = 0
  for (const file of walk('src')) {
    if (file.endsWith('components/ui/control.tsx')) continue
    for (const tag of openingTags(stripComments(readFileSync(file, 'utf8')))) {
      scanned++
      const name = /^<(\w+)/.exec(tag)![1]!
      const className = /className=(?:"([^"]*)"|\{([\s\S]*?)\}(?=\s|\/|>))/.exec(tag)
      const classes = `${className?.[1] ?? ''} ${className?.[2] ?? ''}`
      // An invisible control over a face: sized by `.select-overlay`, or an
      // anchor for the platform's picker, never seen.
      const overlay = /\bselect-overlay\b|\bopacity-0\b/.test(classes)
      const isButton = name === 'Button'
      const bad = (what: string) => findings.push(`${file}: <${name}> ${what}`)

      if (name === 'select' && !overlay) bad('is a bare <select>: use <Select>')
      if (overlay) continue
      const swatch = /type="color"/.test(tag)
      if (!swatch && (/(^|[\s'"`:])h-(\d|\[|px\b|full\b)/.test(classes) || /(^|[\s'"`:])size-(\d|\[)/.test(classes))) {
        if (!/\bicon\b/.test(tag) || !isButton) bad('sets its own height: use size="sm" or the default')
      }
      if (/border-dashed|border-dotted/.test(classes)) bad('is dashed')
      if (/disabled:opacity|opacity-\d+/.test(classes)) bad('fades itself when disabled: the base layer draws disabled')
      if (/(^|[\s'"`:])text-\[/.test(classes)) bad('sets a one-off text size')
      if (/\bfont-mono\b/.test(classes)) bad('sets another font')
      if (!isButton && /outline-none|bg-transparent|border-transparent|(^|\s)border-0\b/.test(classes)) {
        bad('is restyled bare: the base layer is the field')
      }
    }
  }

  it('reads the controls it is checking', () => {
    expect(scanned).toBeGreaterThan(80)
  })

  it('leaves no control restyled one-off', () => {
    expect(findings).toEqual([])
  })
})
