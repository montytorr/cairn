import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HandoffBadge } from './handoff-badge'
import { LabList } from './lab-list'
import { SubjectCard } from './subject-card'
import type { Stage, SubjectSummary } from './types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const stage = (over: Partial<Stage> & Pick<Stage, 'id' | 'name' | 'category'>): Stage => ({
  color: '#6b7fa6',
  position: 0,
  ...over,
})

const exploring = stage({ id: 's1', name: 'exploring', category: 'active' })
const done = stage({ id: 's2', name: 'done', category: 'completed', color: '#5f8a63' })
const dropped = stage({ id: 's3', name: 'rejected', category: 'dropped', color: '#a0685f' })

const subject = (over: Partial<SubjectSummary> = {}): SubjectSummary => ({
  id: 'x1',
  ref: 'LAB-12',
  number: 12,
  title: 'Evaluate pgvector',
  stage: exploring,
  tags: [{ id: 't1', name: 'search', color: '#8a8792', position: 0 }],
  project: { id: 'p1', key: 'CAIRN', title: 'Cairn' },
  owner: { id: 'u1', name: 'Cal' },
  conclusion: null,
  concluded_at: null,
  todos: { open: 2, done: 1 },
  position: 0,
  actor_type: 'human',
  actor_id: 'Cal',
  created_at: '2026-10-10T10:00:00.000Z',
  updated_at: '2026-10-10T11:00:00.000Z',
  archived_at: null,
  ...over,
})

describe('LabList', () => {
  const html = renderToStaticMarkup(
    <LabList
      stages={[exploring, done, dropped]}
      subjects={[subject(), subject({ id: 'x2', ref: 'LAB-3', number: 3, title: 'Try Bun', stage: done, conclusion: 'Faster cold start' })]}
    />,
  )

  it('lists every stage in order, empty ones included', () => {
    expect(html.indexOf('exploring')).toBeLessThan(html.indexOf('done'))
    expect(html.indexOf('done')).toBeLessThan(html.indexOf('rejected'))
    expect(html).toContain('Nothing at this stage.')
  })

  it('links a subject to its page under /lab', () => {
    expect(html).toContain('href="/lab/subjects/12"')
    expect(html).toContain('href="/lab/subjects/3"')
  })

  it('shows the conclusion of a concluded subject', () => {
    expect(html).toContain('Faster cold start')
  })

  it('colours a stage band with the stage’s own colour', () => {
    expect(html).toContain('--band:#5f8a63')
  })
})

describe('SubjectCard', () => {
  it('shows the ref, title, project, tags and the todo tally', () => {
    const html = renderToStaticMarkup(<SubjectCard subject={subject()} />)
    expect(html).toContain('LAB-12')
    expect(html).toContain('Evaluate pgvector')
    expect(html).toContain('CAIRN')
    expect(html).toContain('search')
    expect(html).toContain('1/3')
  })

  it('says nothing of todos when there are none', () => {
    const html = renderToStaticMarkup(<SubjectCard subject={subject({ todos: { open: 0, done: 0 } })} />)
    expect(html).not.toContain('/0')
  })
})

describe('HandoffBadge', () => {
  const handoff = {
    tracker: 'cairn',
    ref: 'KDP-41',
    url: 'https://tasks.example.com/projects/KDP/tasks/41',
    status: 'doing',
    synced_at: null,
  }

  it('links to where the task lives now', () => {
    const html = renderToStaticMarkup(<HandoffBadge handoff={handoff} />)
    expect(html).toContain('href="https://tasks.example.com/projects/KDP/tasks/41"')
    expect(html).toContain('Handed to')
    expect(html).toContain('KDP-41')
  })

  it('reads as history once the hand-off ended', () => {
    const html = renderToStaticMarkup(<HandoffBadge handoff={{ ...handoff, status: 'done' }} />)
    expect(html).toContain('Was handed to')
  })

  it('does not link an address that is not http(s)', () => {
    const html = renderToStaticMarkup(<HandoffBadge handoff={{ ...handoff, url: 'javascript:alert(1)' }} />)
    expect(html).not.toContain('href=')
  })
})
