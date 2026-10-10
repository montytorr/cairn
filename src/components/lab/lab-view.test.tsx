import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NO_FILTERS, type LabFilters } from './filters'
import { LabView } from './lab-view'
import type { Stage, SubjectSummary } from './types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}))

const stage = (id: string, name: string, category: Stage['category']): Stage => ({
  id,
  name,
  category,
  color: '#6b7fa6',
  position: 0,
})
const stages = [
  stage('s1', 'to explore', 'planned'),
  stage('s2', 'exploring', 'active'),
  stage('s3', 'done', 'completed'),
]

let n = 0
const subject = (inStage: Stage): SubjectSummary => {
  n += 1
  return {
    id: `x${n}`,
    ref: `LAB-${n}`,
    number: n,
    title: `Subject ${n}`,
    stage: inStage,
    tags: [],
    project: null,
    owner: null,
    conclusion: null,
    concluded_at: null,
    todos: { open: 0, done: 0 },
    position: 0,
    actor_type: 'human',
    actor_id: 'Cal',
    created_at: '2026-10-10T10:00:00.000Z',
    updated_at: '2026-10-10T10:00:00.000Z',
    archived_at: null,
  }
}

const render = (subjects: SubjectSummary[], filters: LabFilters = NO_FILTERS) =>
  renderToStaticMarkup(
    <LabView
      subjects={subjects}
      stages={stages}
      tags={[]}
      projects={[]}
      initialView="list"
      filters={filters}
    />,
  )

describe('the Lab header counts', () => {
  it('say "1 idea", not "1 ideas"', () => {
    const html = render([subject(stages[0]!)])
    expect(html).toMatch(/>1<\/span> idea</)
    expect(html).not.toMatch(/ ideas</)
  })

  it('say "ideas" for any other number', () => {
    expect(render([subject(stages[0]!), subject(stages[0]!)])).toMatch(/>2<\/span> ideas</)
    expect(render([subject(stages[1]!)])).toMatch(/>0<\/span> ideas</)
  })

  it('count active and concluded subjects with words that do not need a plural', () => {
    const html = render([subject(stages[1]!), subject(stages[2]!), subject(stages[2]!)])
    expect(html).toMatch(/>1<\/span> active</)
    expect(html).toMatch(/>2<\/span> concluded</)
  })
})

describe('the filter toolbar on a phone', () => {
  it('sits behind one Filters button, closed to start with', () => {
    const html = render([subject(stages[0]!)])
    expect(html).toContain('aria-controls="lab-filters"')
    expect(html).toContain('aria-expanded="false"')
    // Hidden on a phone until opened, and part of the toolbar again from `sm`.
    const classes = /id="lab-filters" class="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(classes.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:contents']))
  })

  it('says how many filters are set', () => {
    const html = render([subject(stages[0]!)], { ...NO_FILTERS, stage: ['done'], owner: 'me' })
    expect(html).toMatch(/Filters<span class="tabular">2<\/span>/)
  })

  it('does not count the text search as a filter', () => {
    const html = render([subject(stages[0]!)], { ...NO_FILTERS, q: 'pg' })
    expect(html).not.toContain('class="tabular">1<')
  })
})
