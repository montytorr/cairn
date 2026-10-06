import { describe, expect, it } from 'vitest'
import { cn, taskRefHref } from './utils'

describe('taskRefHref', () => {
  it('builds a task link from a plain ref', () => {
    expect(taskRefHref('CAIRN-75')).toBe('/projects/CAIRN/tasks/75')
  })

  it('handles a project key carrying digits', () => {
    expect(taskRefHref('BB2-3')).toBe('/projects/BB2/tasks/3')
  })

  it('rejects strings with no shape at all', () => {
    // Whether a syntactically valid ref is a REAL project is decided
    // upstream by keepRealRefs before it ever reaches task_refs; this only
    // parses the shape, so it does not need to know SHA-256 is not a task.
    expect(taskRefHref('not a ref')).toBeNull()
    expect(taskRefHref('lowercase-9')).toBeNull()
    expect(taskRefHref('CAIRN')).toBeNull()
  })
})

describe('cn with the type scale', () => {
  it('keeps a scale size next to a colour, and lets a later size win', () => {
    expect(cn('text-meta', 'text-fg-muted')).toBe('text-meta text-fg-muted')
    expect(cn('text-ui text-fg', 'text-meta')).toBe('text-fg text-meta')
  })
})
