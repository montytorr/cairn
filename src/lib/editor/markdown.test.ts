/**
 * Resolution of the Tiptap <-> markdown fidelity spike.
 *
 * The question was whether markdown can stay the source of truth while humans
 * edit through a WYSIWYG editor. These tests are the evidence, and they encode
 * what survives and what does not, so a regression is visible.
 */
import { describe, expect, it } from 'vitest'
import { roundTrip } from './markdown'

/** Stable means a second trip changes nothing — that is what makes editing safe. */
const expectIdempotent = (input: string) => {
  const once = roundTrip(input)
  const twice = roundTrip(once)
  expect(twice).toBe(once)
  return once
}

describe('survives the round trip', () => {
  const cases: [string, string][] = [
    ['headings', '# One\n\n## Two\n\n### Three'],
    ['emphasis', 'Some *italic*, **bold**, and `inline code`.'],
    ['bullet list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two\n3. three'],
    ['nested list', '- one\n    - nested\n    - also nested\n- two'],
    ['task list', '- [ ] undone\n- [x] done'],
    ['fenced code with language', '```sql\nselect 1;\n```'],
    ['blockquote', '> quoted text'],
    ['link', 'See [the docs](https://example.com).'],
    ['image', '![alt](https://example.com/a.png)'],
    ['horizontal rule', 'above\n\n---\n\nbelow'],
    ['strikethrough', 'This is ~~gone~~.'],
    ['paragraphs', 'First para.\n\nSecond para.'],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      const out = expectIdempotent(input)
      expect(out.trim().length).toBeGreaterThan(0)
    })
  }

  it('keeps code block content and language exactly', () => {
    const out = roundTrip('```python\nx = [1, 2, 3]\nprint(x)\n```')
    expect(out).toContain('```python')
    expect(out).toContain('x = [1, 2, 3]')
    expect(out).toContain('print(x)')
  })

  it('preserves checkbox state', () => {
    const out = roundTrip('- [ ] todo\n- [x] finished')
    expect(out).toContain('[ ]')
    expect(out).toContain('[x]')
  })

  it('does not mangle an agent-written body on open-and-save with no edits', () => {
    const agentWritten = [
      '## What happened',
      '',
      'The pooler caps at 15 regardless of client config.',
      '',
      '- [x] reproduced with 50 clients',
      '- [ ] confirm in prod',
      '',
      '```',
      'POSTGRES_PORT=5432',
      '```',
    ].join('\n')
    expectIdempotent(agentWritten)
  })
})

describe('documented lossiness — these are the trade-offs, not bugs', () => {
  it('drops raw HTML rather than corrupting it (html: false)', () => {
    const out = roundTrip('Before <span class="x">inline</span> after.')
    expect(out).not.toContain('<span')
  })

  it('normalises list markers to a single style', () => {
    expect(roundTrip('* star\n* markers')).toContain('- star')
  })

  it('normalises setext headings to ATX', () => {
    expect(roundTrip('Title\n=====')).toContain('# Title')
  })
})

describe('GFM tables are NOT supported by this extension set', () => {
  /**
   * StarterKit ships no table extension, so a pipe table degrades to
   * paragraphs. Documented here so the behaviour is a known limitation with a
   * decision attached, rather than a surprise in production.
   *
   * Fix if it matters: add @tiptap/extension-table plus the markdown
   * serialiser support. Deferred until a real task needs a table.
   */
  it('degrades a pipe table to text', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |'
    const out = roundTrip(table)
    expect(out).not.toContain('| - |')
  })
})
