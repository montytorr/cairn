import { describe, expect, it } from 'vitest'
import {
  closedInKind,
  conclusionMissing,
  handoffOf,
  handoffOutcomeHash,
  handoffUrlProblem,
  isHandedOff,
  nextConcludedAt,
  normalizeHandoffStatus,
  noteContentHash,
  parseSubjectRef,
  refuseHandedOff,
  reservedKeyRefusal,
  stageNoteHash,
  subjectRefQuery,
  withHandoff,
} from './lab-shape'

describe('subject refs', () => {
  it.each([
    ['LAB-12', 12],
    ['lab-12', 12],
    ['12', 12],
    [' LAB-7 ', 7],
    ['LAB%2D3', 3],
  ])('reads %s as %d', (raw, number) => {
    expect(parseSubjectRef(raw)).toBe(number)
  })

  it.each(['S-12', 'LAB-', 'LAB-0', 'CAI-12', 'lab-12x', ''])('refuses %s', (raw) => {
    expect(parseSubjectRef(raw)).toBeNull()
  })

  it('takes only an exact LAB-n as a search address, never a bare number', () => {
    expect(subjectRefQuery('LAB-12')).toBe(12)
    expect(subjectRefQuery(' lab-3 ')).toBe(3)
    expect(subjectRefQuery('12')).toBeNull()
    expect(subjectRefQuery('LAB-12 notes')).toBeNull()
  })

  it('reserves LAB as a project key, in any case', async () => {
    const refused = reservedKeyRefusal('lab')
    expect(refused?.status).toBe(400)
    expect(await refused?.json()).toMatchObject({ code: 'validation_failed', field: 'key' })
    expect(reservedKeyRefusal('LABS')).toBeNull()
    expect(reservedKeyRefusal(undefined)).toBeNull()
  })
})

describe('the conclusion rule', () => {
  const base = { stageChanging: true, conclusionTouched: false }

  it('refuses a move into a completed or dropped stage without a conclusion', () => {
    expect(conclusionMissing({ ...base, targetCategory: 'completed', conclusion: null })).toBe(true)
    expect(conclusionMissing({ ...base, targetCategory: 'dropped', conclusion: '   ' })).toBe(true)
  })

  it('accepts the move with a conclusion, and any move into planned or active', () => {
    expect(conclusionMissing({ ...base, targetCategory: 'completed', conclusion: 'pgvector is enough' })).toBe(false)
    expect(conclusionMissing({ ...base, targetCategory: 'active', conclusion: null })).toBe(false)
    expect(conclusionMissing({ ...base, targetCategory: 'planned', conclusion: null })).toBe(false)
  })

  it('refuses clearing the conclusion of a subject sitting in a concluding stage', () => {
    expect(
      conclusionMissing({ stageChanging: false, conclusionTouched: true, targetCategory: 'completed', conclusion: null }),
    ).toBe(true)
  })

  it('lets an untouched subject in a concluding stage be edited without one', () => {
    expect(
      conclusionMissing({ stageChanging: false, conclusionTouched: false, targetCategory: 'completed', conclusion: null }),
    ).toBe(false)
  })

  it('sets concluded_at entering, keeps it between, and clears it leaving a concluding stage', () => {
    const now = '2026-10-10T20:00:00.000Z'
    const then = '2026-10-01T09:00:00.000Z'
    expect(nextConcludedAt({ fromCategory: 'active', toCategory: 'completed', concludedAt: null, now })).toBe(now)
    expect(nextConcludedAt({ fromCategory: 'completed', toCategory: 'dropped', concludedAt: then, now })).toBe(then)
    expect(nextConcludedAt({ fromCategory: 'completed', toCategory: 'active', concludedAt: then, now })).toBeNull()
  })
})

describe('log hashes', () => {
  it('dedupes a retry of the same kind and text, not the same text under another kind', () => {
    expect(noteContentHash('finding', 'x')).toBe(noteContentHash('finding', 'x'))
    expect(noteContentHash('finding', 'x')).not.toBe(noteContentHash('note', 'x'))
  })

  it('never dedupes two stage moves at different moments', () => {
    expect(stageNoteHash('a', 'b', '2026-10-10T20:00:00Z')).not.toBe(stageNoteHash('a', 'b', '2026-10-10T20:00:01Z'))
  })

  it('keys an outcome on tracker, ref and status only', () => {
    expect(handoffOutcomeHash('cairn', 'KDP-41', 'done')).toBe(handoffOutcomeHash('cairn', 'KDP-41', 'done'))
    expect(handoffOutcomeHash('cairn', 'KDP-41', 'done')).not.toBe(handoffOutcomeHash('cairn', 'KDP-41', 'cancelled'))
  })
})

describe('hand-off shape', () => {
  const open = {
    handoff_tracker: 'cairn',
    handoff_ref: 'KDP-41',
    handoff_url: 'https://tasks.example.com/projects/KDP/tasks/41',
    handoff_status: 'doing',
    handoff_synced_at: '2026-10-10T20:00:00.000Z',
  }

  it('reads the link, and nothing from a row without one', () => {
    expect(handoffOf(open)).toEqual({
      tracker: 'cairn',
      ref: 'KDP-41',
      url: open.handoff_url,
      status: 'doing',
      synced_at: open.handoff_synced_at,
    })
    expect(handoffOf({ handoff_tracker: null, handoff_ref: null })).toBeNull()
  })

  it('folds the raw columns into one handoff field', () => {
    const shaped = withHandoff({ id: 'x', ...open })
    expect(Object.keys(shaped).sort()).toEqual(['handoff', 'id'])
    expect(withHandoff({ id: 'y' })).toEqual({ id: 'y' })
  })

  it('refuses status changes with 409 handed_off while the hand-off is open', async () => {
    expect(isHandedOff(open)).toBe(true)
    const refused = refuseHandedOff(open, 'LT-3')
    expect(refused?.status).toBe(409)
    expect(await refused?.json()).toMatchObject({ code: 'handed_off', tracker: 'cairn', handoffRef: 'KDP-41' })
  })

  it('stops refusing once the tracker ended it', () => {
    for (const status of ['done', 'cancelled']) {
      expect(isHandedOff({ ...open, handoff_status: status })).toBe(false)
      expect(refuseHandedOff({ ...open, handoff_status: status }, 'LT-3')).toBeNull()
    }
    expect(refuseHandedOff({}, 'LT-3')).toBeNull()
  })

  it('makes a cairn hand-off name its instance with an https url', () => {
    expect(handoffUrlProblem('cairn', null)).toMatch(/https URL/)
    expect(handoffUrlProblem('cairn', 'http://tasks.example.com/projects/KDP/tasks/41')).toMatch(/https URL/)
    expect(handoffUrlProblem('cairn', 'https://tasks.example.com/projects/KDP/tasks/41')).toBeNull()
    expect(handoffUrlProblem('github', null)).toBeNull()
  })

  it('reads a tracker\'s ended statuses in any case and spelling', () => {
    expect(normalizeHandoffStatus('Done')).toBe('done')
    expect(normalizeHandoffStatus('closed')).toBe('done')
    expect(normalizeHandoffStatus('COMPLETED')).toBe('done')
    expect(normalizeHandoffStatus('Canceled')).toBe('cancelled')
    expect(normalizeHandoffStatus('In Progress')).toBe('in progress')
  })

  it('closes with the tracker kind when Cairn has it, verified otherwise', () => {
    expect(closedInKind('fixed', ['fixed', 'verified'])).toBe('fixed')
    expect(closedInKind('completed', ['fixed', 'verified'])).toBe('verified')
    expect(closedInKind(undefined, ['fixed', 'verified'])).toBe('verified')
  })
})
