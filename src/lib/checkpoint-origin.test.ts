import { describe, expect, it } from 'vitest'
import { isAutoCheckpoint, isUntouchedAutoCheckpoint, resolutionSuggestion } from './checkpoint-origin'
import { untouchedCheckpoint, workedCheckpoint } from './api/sessions'

describe('checkpoint origin', () => {
  const written = 'Guard suite 18/18 green; the cooldown is uncommitted in worktree mev-auth.'

  it('recognises both automatic kinds from the text the hook writes', () => {
    expect(isAutoCheckpoint(workedCheckpoint('Did it.'))).toBe(true)
    expect(isAutoCheckpoint(untouchedCheckpoint(['CAIRN-277']))).toBe(true)
    expect(isAutoCheckpoint(written)).toBe(false)
    expect(isAutoCheckpoint(null)).toBe(false)
  })

  it('singles out the one that records nothing but holding', () => {
    expect(isUntouchedAutoCheckpoint(untouchedCheckpoint([]))).toBe(true)
    expect(isUntouchedAutoCheckpoint(workedCheckpoint('Did it.'))).toBe(false)
    // Written by someone, even if it happens to start the same way.
    expect(isUntouchedAutoCheckpoint('Still held, not progressed: waiting on legal.')).toBe(false)
  })

  // Five human resolutions were literally "Still held, not progressed…", and
  // three "Next: …": the dialog offered them and people confirmed.
  it('never offers automatic text as a resolution', () => {
    expect(resolutionSuggestion(untouchedCheckpoint(['CAIRN-277']))).toBeNull()
    expect(resolutionSuggestion(workedCheckpoint('Next: Provide conversation transcript'))).toBeNull()
    expect(resolutionSuggestion(written)).toBe(written)
    expect(resolutionSuggestion(null)).toBeNull()
  })
})
