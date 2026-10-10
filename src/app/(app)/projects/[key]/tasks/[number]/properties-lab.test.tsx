import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, Task } from '@/lib/data'
import type { Handoff, TaskLabFields } from '@/components/lab/types'
import { Properties } from './properties'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))

const task = {
  id: 't1',
  number: 41,
  title: 'Ship it',
  description: null,
  type: 'chore',
  status: 'todo',
  priority: 'medium',
  labels: [],
  due_date: null,
  position: 0,
  actor_type: 'human',
  actor_id: 'Cal',
  assignee_user_id: 'u1',
  assignee: { id: 'u1', email: 'c@example.test', name: 'Cal', active: true },
  claimed_by: null,
  claimed_at: null,
  heartbeat_at: null,
  attempt: 1,
  checkpoint_summary: null,
  checkpoint_at: null,
  blocked_reason: null,
  resolution: null,
  resolution_kind: null,
  resolved_at: null,
  resolved_by: null,
  external_ref: null,
  external_url: null,
  has_resolution: false,
  duplicate_of: null,
  parent_id: null,
  created_at: '2026-10-10T10:00:00.000Z',
  updated_at: '2026-10-10T10:00:00.000Z',
} as Task

const project = { id: 'p1', key: 'LT', title: 'Lab todos', description: null, status: 'active', task_counter: 41 } as Project

const render = (lab?: TaskLabFields) =>
  renderToStaticMarkup(<Properties task={task} project={project} projects={[{ key: 'LT', title: 'Lab todos' }]} lab={lab} />)

const handoff = (status: string | null): Handoff => ({
  tracker: 'cairn',
  ref: 'KDP-41',
  url: 'https://tasks.example.com/projects/KDP/tasks/41',
  status,
  synced_at: null,
})

/** The Status row's select, found by its accessible label. */
const statusSelect = (html: string) => /<select[^>]*aria-label="Todo"[^>]*>/.exec(html)?.[0] ?? ''

describe('a task’s properties and the Lab', () => {
  it('draws no Subject row while the Lab is off (the field is absent)', () => {
    expect(render({})).not.toContain('Subject')
  })

  it('draws an empty Subject row, with a way to link, when the Lab is on', () => {
    const html = render({ subject: null })
    expect(html).toContain('Subject')
    expect(html).toContain('Link to a subject')
  })

  it('links the subject it is a todo of', () => {
    const html = render({ subject: { ref: 'LAB-12', title: 'Try pgvector' } })
    expect(html).toContain('href="/lab/subjects/12"')
    expect(html).toContain('Try pgvector')
    expect(html).toContain('Unlink the subject')
  })

  it('leaves the status editable with no hand-off', () => {
    expect(statusSelect(render({ handoff: null }))).not.toContain('disabled')
  })

  it('shows the hand-off and disables the status while it is open', () => {
    const html = render({ handoff: handoff('doing') })
    expect(html).toContain('Handed to')
    expect(html).toContain('KDP-41')
    expect(statusSelect(html)).toContain('disabled')
  })

  it('treats a hand-off that has not reported yet as open', () => {
    expect(statusSelect(render({ handoff: handoff(null) }))).toContain('disabled')
  })

  it('gives the status back once the hand-off ended, keeping the badge as history', () => {
    const html = render({ handoff: handoff('done') })
    expect(statusSelect(html)).not.toContain('disabled')
    expect(html).toContain('Was handed to')
  })
})
