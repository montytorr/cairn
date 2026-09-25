import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAIM_EVIDENCE_EVENTS, lastSignOfLife } from './api/reconcile'
import { HOLDER, LIVENESS_CASES, type EvidenceEvent } from './liveness-fixtures'

/**
 * The reaper's half of the agreement. tests/integration/vitals-signals.test.ts
 * runs the same cases through task_genuine_activity_at (migration 065).
 */
const NOW = Date.parse('2026-09-25T12:00:00Z')
const ago = (hours: number | null) =>
  hours === null ? null : new Date(NOW - hours * 3_600_000).toISOString()

/** What reconcile's lastEvidenceTimes selects: genuine events, by the holder, latest first. */
const lastEvidence = (events: EvidenceEvent[]) => {
  const genuine: readonly string[] = CLAIM_EVIDENCE_EVENTS.genuine
  const hours = events
    .filter((e) => e.actor === HOLDER && genuine.includes(e.event))
    .map((e) => e.hoursAgo)
  return hours.length ? ago(Math.min(...hours)) : null
}

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
        lastEvidence(c.events),
      )
      expect((NOW - at) / 3_600_000).toBe(c.expectedHoursAgo)
    })
  }
})

describe('task_genuine_activity_at names the reaper’s evidence events', () => {
  // The SQL cannot import the list, so the list it spells out is read back
  // and compared, rather than trusted to have been kept in step.
  const sql = readFileSync(join(process.cwd(), 'migrations/065_vitals_signals.sql'), 'utf8')
  const body = sql.slice(sql.indexOf('create or replace function task_genuine_activity_at'))

  it('lists exactly CLAIM_EVIDENCE_EVENTS.genuine, held by the claim holder', () => {
    const listed = /e\.event in \(([^)]*)\)/.exec(body)?.[1] ?? ''
    const events = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(events.sort()).toEqual([...CLAIM_EVIDENCE_EVENTS.genuine].sort())
    expect(body).toContain('e.actor_id = t.claimed_by')
  })

  it('never names an ignored event', () => {
    for (const ignored of CLAIM_EVIDENCE_EVENTS.ignored) {
      expect(body.slice(0, body.indexOf('$$;'))).not.toContain(`'${ignored}'`)
    }
  })
})
