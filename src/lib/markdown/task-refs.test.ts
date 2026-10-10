import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { remarkTaskRefs } from './task-refs'

const render = (md: string, keys: string[] = ['CAI', 'HERMES']) =>
  unified()
    .use(remarkParse)
    .use(remarkTaskRefs, { keys })
    .use(remarkStringify)
    .processSync(md)
    .toString()
    .trim()

describe('remarkTaskRefs', () => {
  it('links a bare ref', () => {
    expect(render('superseded by CAI-31')).toBe('superseded by [CAI-31](/projects/CAI/tasks/31)')
  })

  it('links several refs in one line, keeping the text between them', () => {
    expect(render('CAI-1 and CAI-2 differ')).toBe(
      '[CAI-1](/projects/CAI/tasks/1) and [CAI-2](/projects/CAI/tasks/2) differ',
    )
  })

  it('links across projects', () => {
    expect(render('same cause as HERMES-92')).toContain('/projects/HERMES/tasks/92')
  })

  // The whole reason the plugin takes an allowlist: these have the same shape.
  it.each(['UTF-8', 'HTTP-404', 'SHA-256', 'RFC-2119'])('leaves %s alone', (noise) => {
    expect(render(`see ${noise} for detail`)).toBe(`see ${noise} for detail`)
  })

  it('leaves refs for projects that do not exist', () => {
    expect(render('see NOPE-4')).toBe('see NOPE-4')
  })

  it('does nothing when no keys are known', () => {
    expect(render('see CAI-31', [])).toBe('see CAI-31')
  })

  it('does not touch code', () => {
    expect(render('`CAI-31`')).toBe('`CAI-31`')
    expect(render('```\nCAI-31\n```')).toContain('CAI-31')
    expect(render('```\nCAI-31\n```')).not.toContain('/projects/')
  })

  it('leaves a ref that is already a link', () => {
    const md = '[CAI-31](https://elsewhere.example/CAI-31)'
    expect(render(md)).toBe(md)
  })

  it('does not match a ref glued to other words', () => {
    expect(render('xCAI-31')).toBe('xCAI-31')
  })
})

describe('remarkTaskRefs and Lab subjects (docs/lab.md)', () => {
  const renderLab = (md: string, lab: boolean, keys: string[] = ['CAI']) =>
    unified()
      .use(remarkParse)
      .use(remarkTaskRefs, { keys, lab })
      .use(remarkStringify)
      .processSync(md)
      .toString()
      .trim()

  it('links LAB-12 to the subject while the Lab is on', () => {
    expect(renderLab('see LAB-12 and CAI-3', true)).toBe(
      'see [LAB-12](/lab/subjects/12) and [CAI-3](/projects/CAI/tasks/3)',
    )
  })

  it('leaves LAB-12 as text while the Lab is off', () => {
    expect(renderLab('see LAB-12', false)).toBe('see LAB-12')
  })

  it('keeps task links for a project still keyed LAB while the Lab is off', () => {
    expect(renderLab('see LAB-12', false, ['CAI', 'LAB'])).toBe('see [LAB-12](/projects/LAB/tasks/12)')
  })

  it('makes LAB-12 a subject, never a task, once the Lab is on', () => {
    expect(renderLab('see LAB-12', true, ['CAI', 'LAB'])).toBe('see [LAB-12](/lab/subjects/12)')
  })

  it('links subjects when no project keys are known yet', () => {
    expect(renderLab('LAB-4', true, [])).toBe('[LAB-4](/lab/subjects/4)')
  })
})
