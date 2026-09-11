import { describe, expect, it } from 'vitest'
import type { BoardProject, BoardTask } from '@/lib/board-data'
import {
  UNASSIGNED,
  applyGroupValue,
  buildBoardUrl,
  columnsFor,
  groupValue,
  laneValueOf,
  lanesFor,
  matchesFilters,
  parseFilters,
  serializeFilters,
  type BoardFilters,
} from './board-state'

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: 't1',
  number: 1,
  title: 'Untitled',
  type: 'feature',
  status: 'backlog',
  priority: 'medium',
  labels: [],
  due_date: null,
  position: 0,
  claimed_by: null,
  heartbeat_at: null,
  blocked_reason: null,
  updated_at: '2026-01-01T00:00:00Z',
  preview: null,
  external_ref: null,
  resolution_kind: null,
  has_resolution: false,
  checkpoint_summary: null,
  project_key: 'CAI',
  project_keys: ['CAI'],
  ...overrides,
})

const noFilters: BoardFilters = {
  groupBy: 'status',
  swimlane: 'none',
  projects: [],
  types: [],
  priorities: [],
  labels: [],
  agents: [],
}

const projects: BoardProject[] = [
  { id: 'p1', key: 'CAI', title: 'Cairn' },
  { id: 'p2', key: 'SWV', title: 'Suvie' },
]

describe('parseFilters / serializeFilters', () => {
  it('round-trips a fully populated set', () => {
    const filters: BoardFilters = {
      groupBy: 'priority',
      swimlane: 'project',
      projects: ['CAI', 'SWV'],
      types: ['bug'],
      priorities: ['high', 'urgent'],
      labels: ['frontend'],
      agents: ['claude-code'],
    }
    expect(parseFilters(serializeFilters(filters))).toEqual(filters)
  })

  it('a plain link has an empty query string', () => {
    expect(serializeFilters(noFilters)).toBe('')
  })

  it('falls back to defaults on a nonsense query string, rather than throwing', () => {
    expect(parseFilters('?groupBy=nonsense&swimlane=whatever')).toEqual(noFilters)
  })

  it('ignores an empty list param instead of producing [""]', () => {
    expect(parseFilters('?project=').projects).toEqual([])
  })
})

describe('buildBoardUrl', () => {
  it('carries the closed toggle over from the current URL', () => {
    const url = buildBoardUrl('/board', { ...noFilters, groupBy: 'agent' }, '?closed=1')
    expect(url).toBe('/board?groupBy=agent&closed=1')
  })

  it('produces a bare path when nothing is set', () => {
    expect(buildBoardUrl('/board', noFilters, '')).toBe('/board')
  })
})

describe('matchesFilters', () => {
  it('passes everything when no filter is active', () => {
    expect(matchesFilters(task(), noFilters)).toBe(true)
  })

  it('filters unassigned tasks under the UNASSIGNED sentinel, not null', () => {
    const filters = { ...noFilters, agents: [UNASSIGNED] }
    expect(matchesFilters(task({ claimed_by: null }), filters)).toBe(true)
    expect(matchesFilters(task({ claimed_by: 'someone' }), filters)).toBe(false)
  })

  it('a label filter matches on any overlap, not full equality', () => {
    const filters = { ...noFilters, labels: ['a', 'b'] }
    expect(matchesFilters(task({ labels: ['b', 'c'] }), filters)).toBe(true)
    expect(matchesFilters(task({ labels: ['c'] }), filters)).toBe(false)
  })
})

describe('groupValue / applyGroupValue', () => {
  it('round-trips a project move', () => {
    const t = task({ project_key: 'CAI' })
    expect(groupValue(t, 'project')).toBe('CAI')
    const moved = applyGroupValue(t, 'project', 'SWV')
    expect(groupValue(moved, 'project')).toBe('SWV')
  })

  it('maps a null claim to the UNASSIGNED sentinel and back', () => {
    const t = task({ claimed_by: null })
    expect(groupValue(t, 'agent')).toBe(UNASSIGNED)
    const claimed = applyGroupValue(t, 'agent', 'claude-code')
    expect(claimed.claimed_by).toBe('claude-code')
    const released = applyGroupValue(claimed, 'agent', UNASSIGNED)
    expect(released.claimed_by).toBeNull()
  })
})

describe('columnsFor', () => {
  it('always includes Unassigned first for agent grouping, even with no claims', () => {
    const cols = columnsFor('agent', [task({ claimed_by: null })], projects)
    expect(cols[0]).toEqual({ value: UNASSIGNED, label: 'Unassigned' })
  })

  it('keeps a project column even when every one of its tasks is filtered out elsewhere', () => {
    // columnsFor takes the full task set, not a filtered one — this is what
    // that contract looks like: a project with tasks still gets a column.
    const cols = columnsFor('project', [task({ project_key: 'SWV' })], projects)
    expect(cols.map((c) => c.value)).toEqual(['CAI', 'SWV'])
  })
})

describe('lanesFor', () => {
  it('is a single unlabelled lane when swimlanes are off', () => {
    expect(lanesFor('none', [task()], projects)).toEqual([{ value: 'all', label: '' }])
  })

  it('drops a lane with nothing currently visible in it', () => {
    const visible = [task({ project_key: 'CAI' })]
    const lanes = lanesFor('project', visible, projects)
    expect(lanes.map((l) => l.value)).toEqual(['CAI'])
  })

  it('sorts Unassigned first among agent lanes', () => {
    const visible = [task({ claimed_by: 'zeta' }), task({ claimed_by: null })]
    const lanes = lanesFor('agent', visible, projects)
    expect(lanes.map((l) => l.value)).toEqual([UNASSIGNED, 'zeta'])
  })
})

describe('laneValueOf', () => {
  it('agrees with lanesFor on what an unassigned task is called', () => {
    expect(laneValueOf(task({ claimed_by: null }), 'agent')).toBe(UNASSIGNED)
  })
})

describe('supra-project tasks', () => {
  it('matches a project filter through a secondary link, not just its home', () => {
    const guest = { ...task({ id: 'g' }), project_key: 'CAIRN', project_keys: ['CAIRN', 'HM'] }
    expect(matchesFilters(guest, { ...noFilters, projects: ['HM'] })).toBe(true)
  })

  it('still groups it under the project that owns its ref', () => {
    const guest = { ...task({ id: 'g' }), project_key: 'CAIRN', project_keys: ['CAIRN', 'HM'] }
    expect(groupValue(guest, 'project')).toBe('CAIRN')
  })
})
