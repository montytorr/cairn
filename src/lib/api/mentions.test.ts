import { describe, expect, it } from 'vitest'

import { excerptAround, groupMentions, plainText, shortActor } from './mentions'

describe('excerptAround', () => {
  it('returns short text whole, flattened to one line', () => {
    expect(excerptAround('same cause as\nBB-333,  fixed there', 'BB-333')).toBe(
      'same cause as BB-333, fixed there',
    )
  })

  it('centres a long text on the ref and cuts on word boundaries', () => {
    const before = 'word '.repeat(80)
    const after = ' tail'.repeat(80)
    const out = excerptAround(`${before}do NOT generalise to BB-333 here${after}`, 'BB-333')

    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toContain('do NOT generalise to BB-333 here')
    // Whole words at both cuts, never half of one.
    expect(out).toMatch(/^…word /)
    expect(out).toMatch(/ tail…$/)
    expect(out.length).toBeLessThan(360)
  })

  it('does not take a longer ref for the one asked about', () => {
    const out = excerptAround(`${'x '.repeat(200)}BB-3330 is different; BB-333 is this one`, 'BB-333')
    expect(out).toContain('BB-333 is this one')
  })
})

describe('groupMentions and shortActor (CAIRN-362)', () => {
  const m = (ref: string, kind: string | null, at: string) =>
    ({ ref, title: `${ref} title`, status: 'done', source: 'note', kind, by: null, at, writtenAs: ref, excerpt: '' }) as never

  it('folds mentions by source task and keeps the best-ranked mention first', () => {
    const groups = groupMentions([m('BB-507', 'decision', 'a'), m('BB-502', 'finding', 'b'), m('BB-507', 'finding', 'c')])
    expect(groups.map((g) => [g.ref, g.entries.length])).toEqual([['BB-507', 2], ['BB-502', 1]])
  })

  it('drops the account an agent runs under, and the domain of a bare email', () => {
    expect(shortActor('claude-code · monty.torr@gmail.com')).toBe('claude-code')
    expect(shortActor('monty.torr@gmail.com')).toBe('monty.torr')
    expect(shortActor(null)).toBeNull()
  })
})

describe('plainText (CAIRN-362)', () => {
  it('drops the markdown a reader of the rendered note would not see', () => {
    expect(plainText('## Synthesis: how to\n**Diagnosis.** tm-bl is `fixed` at [[mint-slug]] and [a link](http://x)')).toBe(
      'Synthesis: how to Diagnosis. tm-bl is fixed at mint-slug and a link',
    )
  })
})
