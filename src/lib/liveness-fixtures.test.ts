import { describe, expect, it } from 'vitest'
import { lastSignOfLife } from './api/reconcile'
import { LIVENESS_CASES } from './liveness-fixtures'

/**
 * The reaper's half of the agreement. tests/integration/vitals-signals.test.ts
 * runs the same cases through task_genuine_activity_at (migration 065).
 */
const NOW = Date.parse('2026-09-25T12:00:00Z')
const ago = (hours: number | null) =>
  hours === null ? null : new Date(NOW - hours * 3_600_000).toISOString()

describe('lastSignOfLife on the shared liveness cases', () => {
  for (const c of LIVENESS_CASES) {
    it(c.name, () => {
      const at = lastSignOfLife(
        {
          claimed_at: ago(c.claimedHoursAgo),
          heartbeat_at: ago(c.heartbeatHoursAgo),
          checkpoint_summary: c.checkpoint,
          checkpoint_at: ago(c.checkpointHoursAgo),
          updated_at: ago(c.updatedHoursAgo),
        },
        ago(c.noteHoursAgo),
      )
      expect((NOW - at) / 3_600_000).toBe(c.expectedHoursAgo)
    })
  }
})
