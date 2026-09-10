import { describe, expect, it } from 'vitest'
import { applySelection } from './selection'

const rows = ['a', 'b', 'c', 'd', 'e']
const set = (...ids: string[]) => new Set(ids)
const sorted = (s: Set<string>) => [...s].sort()

describe('applySelection', () => {
  it('selects an unselected row', () => {
    expect(sorted(applySelection(set(), rows, 'b', { shiftKey: false, anchor: null }))).toEqual(['b'])
  })

  it('deselects a selected row', () => {
    expect(sorted(applySelection(set('b'), rows, 'b', { shiftKey: false, anchor: 'b' }))).toEqual([])
  })

  // The bug as reported: "it only changes state once we select the next one".
  // A single click must land exactly once.
  it('toggles once per click, not twice', () => {
    let s: Set<string> = set()
    s = applySelection(s, rows, 'c', { shiftKey: false, anchor: null })
    expect(sorted(s)).toEqual(['c'])
    s = applySelection(s, rows, 'c', { shiftKey: false, anchor: 'c' })
    expect(sorted(s)).toEqual([])
  })

  describe('shift-click range', () => {
    it('fills forwards from the anchor', () => {
      const s = applySelection(set('b'), rows, 'd', { shiftKey: true, anchor: 'b' })
      expect(sorted(s)).toEqual(['b', 'c', 'd'])
    })

    it('fills backwards from the anchor', () => {
      const s = applySelection(set('d'), rows, 'b', { shiftKey: true, anchor: 'd' })
      expect(sorted(s)).toEqual(['b', 'c', 'd'])
    })

    it('always adds, never toggles rows already in the range', () => {
      const s = applySelection(set('a', 'c', 'e'), rows, 'e', { shiftKey: true, anchor: 'a' })
      expect(sorted(s)).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('keeps a selection made outside the range', () => {
      const s = applySelection(set('a'), rows, 'd', { shiftKey: true, anchor: 'c' })
      expect(sorted(s)).toEqual(['a', 'c', 'd'])
    })

    it('falls back to a plain toggle with no anchor', () => {
      expect(sorted(applySelection(set(), rows, 'c', { shiftKey: true, anchor: null }))).toEqual(['c'])
    })

    it('falls back to a plain toggle when shift-clicking the anchor itself', () => {
      expect(sorted(applySelection(set('c'), rows, 'c', { shiftKey: true, anchor: 'c' }))).toEqual([])
    })

    // A collapsed group or a changed filter can leave an anchor that is no
    // longer on screen; a range to nowhere must not wipe the selection.
    it('falls back to a plain toggle when the anchor has left the list', () => {
      const s = applySelection(set('b'), rows, 'd', { shiftKey: true, anchor: 'zz' })
      expect(sorted(s)).toEqual(['b', 'd'])
    })
  })
})
