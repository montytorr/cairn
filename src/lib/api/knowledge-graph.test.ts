import { describe, expect, it } from 'vitest'
import { EXCERPT_CAP, excerptOf, referencesIn } from './knowledge-graph'

/**
 * The edges of this graph live in prose, not in a table, so reading them out
 * has to agree exactly with what the renderer linkifies. Anywhere the two
 * disagree the map shows a connection the page does not, or hides one it does
 * — and a map that disagrees with the thing it maps is worse than none.
 */
describe('reading references out of a body', () => {
  it('finds a reference', () => {
    expect(referencesIn('See [[proxy-buffer-defaults]] for the layout.')).toEqual([
      'proxy-buffer-defaults',
    ])
  })

  it('normalises the underscore spelling, like the renderer does', () => {
    // Most references in the store are written this way. Reading them
    // literally would leave the map almost edgeless while the pages show
    // links everywhere.
    expect(referencesIn('Related: [[cache_warmup_race]]')).toEqual(['cache-warmup-race'])
  })

  it('counts a reference once however often it is repeated', () => {
    // An entry that mentions another three times is joined to it once. Left
    // uncounted, the busiest entries would look busier still.
    expect(referencesIn('[[a-slug]] and again [[a-slug]] and [[a_slug]]')).toEqual(['a-slug'])
  })

  it('ignores a reference inside a fenced code block', () => {
    // The renderer never linkifies inside a fence, because the parser hands it
    // a code node rather than text. Reading raw bodies has no such help, so an
    // EXAMPLE in a fence would otherwise become a real edge.
    const body = ['Prose [[real-one]].', '```', 'cairn know [[an-example]]', '```'].join('\n')

    expect(referencesIn(body)).toEqual(['real-one'])
  })

  it('ignores single brackets, which are ordinary markdown', () => {
    expect(referencesIn('A [link](https://example.com) and [brackets].')).toEqual([])
  })

  it('returns nothing for a body with no references', () => {
    expect(referencesIn('Just prose, no references at all.')).toEqual([])
  })

  it('handles an empty body', () => {
    expect(referencesIn('')).toEqual([])
  })
})

/**
 * What the map's hover card says about an entry (CAIRN-349). It is read out
 * of the raw body on the server, so everything the renderer would hide —
 * markdown syntax, headings, code — has to be hidden here too, or the card
 * shows asterisks and brackets the page never does.
 */
describe('the excerpt the map shows on hover', () => {
  it('takes the first line of prose, past the headings', () => {
    expect(excerptOf('# Proxy buffers\n\n## Context\n\nNginx buffers responses by default.')).toBe(
      'Nginx buffers responses by default.',
    )
  })

  it('reads markdown the way the rendered page reads', () => {
    expect(
      excerptOf('See **the** [[proxy-buffer-defaults]] and `proxy_buffering` in [the docs](https://x.y) _now_.'),
    ).toBe('See the proxy-buffer-defaults and proxy_buffering in the docs now.')
  })

  it('keeps underscores that are part of a word', () => {
    expect(excerptOf('Set cache_warmup_race off.')).toBe('Set cache_warmup_race off.')
  })

  it('skips code, tables, rules and front matter', () => {
    const body = [
      '---',
      'tags: [a]',
      '---',
      '```sh',
      'echo not prose',
      '```',
      '| a | b |',
      '|---|---|',
      '***',
      'Actually said.',
    ].join('\n')
    expect(excerptOf(body)).toBe('Actually said.')
  })

  it('skips a setext heading as well as an ATX one', () => {
    expect(excerptOf('Title here\n==========\n\nThe point.')).toBe('The point.')
  })

  it('joins a hard-wrapped paragraph, but not the next bullet', () => {
    expect(excerptOf('The first half\nand the rest.\n\nAnother paragraph.')).toBe(
      'The first half and the rest.',
    )
    expect(excerptOf('- one thing\n- another thing')).toBe('one thing')
  })

  it('does not repeat the title back', () => {
    expect(excerptOf('Proxy buffers\n\nThey are on by default.', 'Proxy buffers')).toBe(
      'They are on by default.',
    )
  })

  it('caps a long paragraph at a word, and says it was cut', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const out = excerptOf(long)
    expect(out.length).toBeLessThanOrEqual(EXCERPT_CAP)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s…$/)
    expect(long.startsWith(out.slice(0, -1))).toBe(true)
  })

  it('says nothing for a body with nothing to say', () => {
    expect(excerptOf('')).toBe('')
    expect(excerptOf('# Only a heading\n\n```\ncode\n```')).toBe('')
  })
})
