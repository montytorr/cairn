import { AUTO_CHECKPOINT_MARKER, UNTOUCHED_CHECKPOINT_PREFIX } from './checkpoint-origin'

/**
 * One set of cases for the two places that decide whether a claim is alive.
 *
 * The reaper decides in TypeScript (`lastSignOfLife`, src/lib/api/reconcile.ts)
 * and vitals decides in SQL (`task_genuine_activity_at`, migration 065). If
 * they disagreed, vitals would alarm `reaper-idle` about claims the reaper
 * rightly keeps, or say nothing about claims it is about to release. So each
 * case states the answer once, and both suites must produce it:
 * src/lib/liveness-fixtures.test.ts through lastSignOfLife, and
 * tests/integration/vitals-signals.test.ts through the SQL function.
 *
 * Times are hours before "now"; null is absent. `expectedHoursAgo` is the
 * last sign of life.
 */
/** The claim's holder in every case; any other actor is not the holder. */
export const HOLDER = 'openclaw · Dev'

export type EvidenceEvent = { event: string; hoursAgo: number; actor: string }

export type LivenessCase = {
  name: string
  claimedHoursAgo: number
  heartbeatHoursAgo: number | null
  checkpoint: string | null
  checkpointHoursAgo: number | null
  updatedHoursAgo: number
  noteHoursAgo: number | null
  events: EvidenceEvent[]
  expectedHoursAgo: number
}

const untouched = `${UNTOUCHED_CHECKPOINT_PREFIX}: the session that held this claim worked on CAIRN-277.\n\n${AUTO_CHECKPOINT_MARKER}`
const worked = `Shipped the handler.\n\n${AUTO_CHECKPOINT_MARKER}`

const base = {
  claimedHoursAgo: 168,
  heartbeatHoursAgo: null,
  checkpoint: null,
  checkpointHoursAgo: null,
  updatedHoursAgo: 168,
  noteHoursAgo: null,
  events: [] as EvidenceEvent[],
}

const by = (event: string, hoursAgo: number, actor = HOLDER): EvidenceEvent => ({ event, hoursAgo, actor })

export const LIVENESS_CASES: LivenessCase[] = [
  { ...base, name: 'claimed and never touched', expectedHoursAgo: 168 },
  {
    // BB-385: the session-end sweep wrote "still held" at 09:00, a week in.
    ...base,
    name: 'only a "still held" auto-checkpoint since the claim',
    checkpoint: untouched,
    checkpointHoursAgo: 1,
    expectedHoursAgo: 168,
  },
  {
    ...base,
    name: '"still held" with trailing whitespace after the marker',
    checkpoint: `${untouched}\n  \n`,
    checkpointHoursAgo: 1,
    expectedHoursAgo: 168,
  },
  {
    // The session did work the task, so the reaper counts it.
    ...base,
    name: 'an auto-checkpoint from a session that worked the task',
    checkpoint: worked,
    checkpointHoursAgo: 3,
    expectedHoursAgo: 3,
  },
  {
    ...base,
    name: 'a written checkpoint that happens to begin like the automatic one',
    checkpoint: `${UNTOUCHED_CHECKPOINT_PREFIX}: waiting on legal.`,
    checkpointHoursAgo: 4,
    expectedHoursAgo: 4,
  },
  {
    ...base,
    name: 'the marker quoted mid-text is not the marker',
    checkpoint: `${UNTOUCHED_CHECKPOINT_PREFIX}. It said "${AUTO_CHECKPOINT_MARKER}" and then I carried on.`,
    checkpointHoursAgo: 5,
    expectedHoursAgo: 5,
  },
  { ...base, name: 'a heartbeat', heartbeatHoursAgo: 6, expectedHoursAgo: 6 },
  { ...base, name: 'a note', noteHoursAgo: 7, expectedHoursAgo: 7 },
  { ...base, name: 'an edit to the task', updatedHoursAgo: 8, expectedHoursAgo: 8 },
  { ...base, name: 'a recent claim', claimedHoursAgo: 2, updatedHoursAgo: 2, expectedHoursAgo: 2 },
  { ...base, name: 'a commit by the holder', events: [by('git_commit', 9)], expectedHoursAgo: 9 },
  { ...base, name: 'a push by the holder', events: [by('git_push', 11)], expectedHoursAgo: 11 },
  { ...base, name: 'a test run by the holder', events: [by('run_result', 12)], expectedHoursAgo: 12 },
  { ...base, name: 'a deliberate checkpoint event by the holder', events: [by('checkpointed', 13)], expectedHoursAgo: 13 },
  { ...base, name: 'a status move by the holder', events: [by('status_changed', 14)], expectedHoursAgo: 14 },
  {
    ...base,
    name: 'evidence by somebody other than the holder',
    events: [by('git_commit', 1, 'claude-code · Dev'), by('status_changed', 1, 'Dev')],
    expectedHoursAgo: 168,
  },
  {
    // 063's automatic checkpoint event, and ownership bookkeeping.
    ...base,
    name: 'auto_checkpointed, released and claimed events by the holder',
    events: [by('auto_checkpointed', 1), by('released', 1), by('claimed', 1)],
    expectedHoursAgo: 168,
  },
  {
    ...base,
    name: 'an event that is not evidence at all',
    events: [by('body_edited', 1)],
    expectedHoursAgo: 168,
  },
  {
    ...base,
    name: 'the latest of several signs wins',
    heartbeatHoursAgo: 30,
    checkpoint: 'Handler done, tests next',
    checkpointHoursAgo: 20,
    noteHoursAgo: 10,
    updatedHoursAgo: 40,
    events: [by('git_commit', 15), by('run_result', 3, 'codex · Dev')],
    expectedHoursAgo: 10,
  },
]
