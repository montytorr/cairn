import { describe, expect, it } from 'vitest'
import type { ActivityRow } from '@/lib/api/activity-feed'
import { hrefFor, titleFor } from './activity-list'

const row = (overrides: Partial<ActivityRow>): ActivityRow => ({
  kind: 'event',
  at: '2026-09-22T08:00:00.000Z',
  actor: 'claude-code',
  project_key: 'HOL',
  ref: 'HOL',
  title: '',
  detail: 'project_key_changed',
  ...overrides,
})

describe('project events in the activity feed', () => {
  it('link a project-level event to the project', () => {
    expect(hrefFor(row({}))).toBe('/projects/HOL')
  })

  it('still link a task event to the task', () => {
    expect(hrefFor(row({ ref: 'HOL-113', detail: 'status_changed' }))).toBe('/projects/HOL/tasks/113')
  })

  it('say something when the feed sent no title', () => {
    expect(titleFor(row({}))).toBe('Project key changed — now HOL')
    expect(titleFor(row({ detail: 'project_renamed' }))).toBe('Project HOL renamed')
  })

  it('prefer the title the feed supplies', () => {
    expect(titleFor(row({ title: 'AC → HOL' }))).toBe('AC → HOL')
  })
})

describe('Lab subject rows in the activity feed', () => {
  it('link a subject event to the subject, not to a project called LAB', () => {
    expect(hrefFor(row({ ref: 'LAB-12', project_key: null, detail: 'subject_stage_changed' }))).toBe(
      '/lab/subjects/12',
    )
  })

  it('link a log note of a subject the same way', () => {
    expect(hrefFor(row({ kind: 'note', ref: 'LAB-7', project_key: 'CAIRN', detail: 'finding' }))).toBe(
      '/lab/subjects/7',
    )
  })

  it('do not take a task whose key merely starts like it', () => {
    expect(hrefFor(row({ ref: 'LABS-4', detail: 'status_changed' }))).toBe('/projects/LABS/tasks/4')
  })
})
