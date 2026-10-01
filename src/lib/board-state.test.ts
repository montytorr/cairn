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
  assignee_user_id: 'u1',
  assignee: { id: 'u1', email: 'alice@example.com', name: 'Alice', active: true },
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
  parent_id: null,
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
  assignees: [],
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
      assignees: ['u1'],
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

  it('filters by assignee id, unlike agent there is no unassigned sentinel', () => {
    const filters = { ...noFilters, assignees: ['u1'] }
    expect(matchesFilters(task({ assignee_user_id: 'u1' }), filters)).toBe(true)
    expect(matchesFilters(task({ assignee_user_id: 'u2' }), filters)).toBe(false)
  })
})

describe('the assignee filter, for a known viewer (CAIRN-339)', () => {
  it('shows the viewer their own tasks when the link names nobody', () => {
    expect(parseFilters('', 'u-me').assignees).toEqual(['u-me'])
    expect(parseFilters('?groupBy=project', 'u-me').assignees).toEqual(['u-me'])
  })

  it('reads all as everyone, and me as whoever opens it', () => {
    expect(parseFilters('?assignee=all', 'u-me').assignees).toEqual([])
    expect(parseFilters('?assignee=me,u2', 'u-me').assignees).toEqual(['u-me', 'u2'])
  })

  it('keeps the default link plain, and says all when it means everyone', () => {
    expect(serializeFilters({ ...noFilters, assignees: ['u-me'] }, 'u-me')).toBe('')
    expect(serializeFilters({ ...noFilters, assignees: [] }, 'u-me')).toBe('assignee=all')
    expect(buildBoardUrl('/board', { ...noFilters, assignees: [] }, '?closed=1', 'u-me')).toBe('/board?assignee=all&closed=1')
  })

  it('round-trips through the URL for the same viewer', () => {
    for (const assignees of [['u-me'], [], ['u2'], ['u-me', 'u2']]) {
      const filters = { ...noFilters, assignees }
      expect(parseFilters(serializeFilters(filters, 'u-me'), 'u-me')).toEqual(filters)
    }
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

  it('groups by assignee id, every task has one', () => {
    const t = task({ assignee_user_id: 'u1', assignee: { id: 'u1', email: 'a@x.com', name: 'Alice', active: true } })
    expect(groupValue(t, 'assignee')).toBe('u1')
    const moved = applyGroupValue(t, 'assignee', 'u2')
    expect(groupValue(moved, 'assignee')).toBe('u2')
  })
})

describe('columnsFor', () => {
  it('always includes Unclaimed first for agent grouping, even with no claims', () => {
    const cols = columnsFor('agent', [task({ claimed_by: null })], projects)
    expect(cols[0]).toEqual({ value: UNASSIGNED, label: 'Unclaimed' })
  })

  it('names assignee columns off the task rows, not a sentinel', () => {
    const cols = columnsFor(
      'assignee',
      [
        task({ assignee_user_id: 'u2', assignee: { id: 'u2', email: 'b@x.com', name: 'Bob', active: true } }),
        task({ assignee_user_id: 'u1', assignee: { id: 'u1', email: 'a@x.com', name: 'Alice', active: true } }),
      ],
      projects,
    )
    expect(cols).toEqual([
      { value: 'u1', label: 'Alice' },
      { value: 'u2', label: 'Bob' },
    ])
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

  it('sorts Unclaimed first among agent lanes', () => {
    const visible = [task({ claimed_by: 'zeta' }), task({ claimed_by: null })]
    const lanes = lanesFor('agent', visible, projects)
    expect(lanes.map((l) => l.value)).toEqual([UNASSIGNED, 'zeta'])
    expect(lanes[0]).toEqual({ value: UNASSIGNED, label: 'Unclaimed' })
  })

  it('names assignee lanes off the visible task rows', () => {
    const visible = [
      task({ assignee_user_id: 'u1', assignee: { id: 'u1', email: 'a@x.com', name: 'Alice', active: true } }),
    ]
    const lanes = lanesFor('assignee', visible, projects)
    expect(lanes).toEqual([{ value: 'u1', label: 'Alice' }])
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
