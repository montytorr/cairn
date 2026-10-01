import { describe, expect, it } from 'vitest'
import { nestTasks } from './nest-tasks'

const t = (id: string, parent_id: string | null = null) => ({ id, parent_id })
const shape = (rows: ReturnType<typeof nestTasks<{ id: string; parent_id: string | null }>>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.task.id}${r.nested ? `(${r.nested})` : ''}`)

describe('nesting sub-tasks in a list', () => {
  it('puts each child directly under its parent, keeping the order given', () => {
    const rows = nestTasks([t('a'), t('b'), t('a1', 'a'), t('c'), t('a2', 'a'), t('b1', 'b')])
    expect(shape(rows)).toEqual(['a(2)', '  a1', '  a2', 'b(1)', '  b1', 'c'])
  })

  it('nests deeper levels too', () => {
    expect(shape(nestTasks([t('a'), t('a1', 'a'), t('a1x', 'a1')]))).toEqual(['a(1)', '  a1(1)', '    a1x'])
  })

  it('leaves a child flat when its parent is not in this list', () => {
    expect(shape(nestTasks([t('x1', 'elsewhere'), t('b')]))).toEqual(['x1', 'b'])
  })

  it('hides the children of a collapsed parent, and their children, without losing count', () => {
    const rows = nestTasks([t('a'), t('a1', 'a'), t('a1x', 'a1'), t('b')], new Set(['a']))
    expect(shape(rows)).toEqual(['a(1)', 'b'])
  })

  it('shows a cycle flat rather than looping or dropping it', () => {
    const rows = nestTasks([t('p', 'q'), t('q', 'p'), t('self', 'self')])
    expect(rows.map((r) => r.task.id).sort()).toEqual(['p', 'q', 'self'])
  })
})
