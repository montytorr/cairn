import { unstable_cache } from 'next/cache'
import { admin } from '@/lib/db/client'
import type { Actor } from './auth'

/**
 * Whether Cairn is still working.
 *
 * Everything that broke this week broke quietly. Sessions recorded nothing for
 * two days; ten tasks sat in In Progress with nobody on them; every automatic
 * release was filed under the wrong agent. Nothing threw. Each was a number
 * that should not have been what it was, and each was found by a person
 * looking rather than by the system saying so.
 *
 * So the check is deliberately not "is the service up" — the liveness probe
 * already answers that, and answered it happily throughout. It is "is the
 * memory still being written", which is a different question and the one that
 * actually matters.
 */

export type Vitals = {
  windowHours: number
  sessions: { recent: number; recentWithFiles: number; baseline: number; baselineWithFiles: number }
  tasks: { opened: number; closed: number; stalled: number; held: number }
  autoReleased: number
  knowledgeWritten: number
  agents: { agent: string; recent: number; baseline: number }[]
}

export type Finding = {
  code: string
  severity: 'alarm' | 'warning'
  message: string
}

/** The baseline the function returns covers a week. */
const BASELINE_HOURS = 168

/**
 * What the numbers mean.
 *
 * Pure, because this is the part worth testing and the part that will be
 * argued with. A count on its own says nothing: "no sessions today" is alarming
 * on a working week and meaningless over Christmas, so every check compares
 * against the week before, scaled to the same window length.
 */
export const assess = (v: Vitals): Finding[] => {
  const findings: Finding[] = []
  const scale = v.windowHours / BASELINE_HOURS
  const expected = (baseline: number) => baseline * scale
  const hours = `${v.windowHours}h`

  // The two-day outage, in one check. Hooks that stop firing produce silence,
  // and silence is indistinguishable from a quiet day unless you look back.
  if (v.sessions.recent === 0 && expected(v.sessions.baseline) >= 1) {
    findings.push({
      code: 'no-sessions',
      severity: 'alarm',
      message:
        `No session recorded in ${hours}, against ${v.sessions.baseline} in the week before. ` +
        `The session hooks are not running, or cannot write.`,
    })
  }

  // The jsonb bug, in one check. Sessions kept being written; the ones that
  // touched a file — nearly all real work — were the ones being rejected, so
  // the total never went to zero and nothing looked wrong.
  if (
    v.sessions.recent >= 3 &&
    v.sessions.recentWithFiles === 0 &&
    v.sessions.baselineWithFiles > 0
  ) {
    findings.push({
      code: 'sessions-without-files',
      severity: 'alarm',
      message:
        `${v.sessions.recent} sessions recorded in ${hours} and not one names a file. ` +
        `Sessions that touch files are failing, or the file index is not being written.`,
    })
  }

  // An agent that has gone silent is the clearest sign its wiring broke, and
  // it is invisible in any total: the others go on writing.
  for (const agent of v.agents) {
    if (agent.recent === 0 && expected(agent.baseline) >= 3) {
      findings.push({
        code: 'agent-silent',
        severity: 'alarm',
        message:
          `${agent.agent} has written nothing in ${hours}, against ${agent.baseline} in the week ` +
          `before. Its hooks or its key may have stopped working.`,
      })
    }
  }

  // Not a breakage — a habit. Worth saying once it is a pattern rather than
  // an incident, which is why this is a count and not a ratio.
  if (v.tasks.stalled > 5) {
    findings.push({
      code: 'stalled-work',
      severity: 'warning',
      message:
        `${v.tasks.stalled} tasks are in progress with nobody holding them. ` +
        `Started and dropped is the easiest work in the tracker to lose.`,
    })
  }

  if (v.autoReleased >= 5) {
    findings.push({
      code: 'claims-abandoned',
      severity: 'warning',
      message:
        `${v.autoReleased} claims were released automatically in ${hours}. ` +
        `Work is being claimed and then left.`,
    })
  }

  // Opening without closing is how a tracker becomes a landfill. Only worth
  // saying when the sample is big enough to be a trend.
  if (v.tasks.opened >= 5 && v.tasks.closed === 0) {
    findings.push({
      code: 'nothing-closed',
      severity: 'warning',
      message: `${v.tasks.opened} tasks opened in ${hours} and none closed.`,
    })
  }

  return findings
}

/**
 * The shape of the work, as opposed to the health of the system.
 *
 * Deliberately not a leaderboard. The agents read Cairn -- it is their working
 * memory -- so a visible closure score creates an incentive to close things,
 * which is the one behaviour least worth optimising. Per agent there is only
 * what is actionable: what it holds now, and what it walked away from.
 */
export type WorkShape = {
  windowHours: number
  openTotal: number
  stalledTotal: number
  projects: { key: string; open: number; stalled: number; oldestDays: number; neverTouched: number }[]
  holding: { agent: string; ref: string; title: string; heldMinutes: number }[]
  dropped: { agent: string; count: number }[]
  rework: { reopened: number; resolutionsRevised: number; duplicatesFiled: number }
}

export const readWorkShapeFor = async (userId: string, hours = 24): Promise<WorkShape> => {
  const { data, error } = await admin().rpc('cairn_work_shape', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as WorkShape
}

/**
 * Whether anybody consults what is already known.
 *
 * Every other number in here describes what was written; none described
 * whether any of it was read. A store nobody queries is an expensive way to
 * write into a drawer.
 */
export type MemoryUse = {
  windowHours: number
  searches: number
  zeroResults: number
  byAgent: { agent: string; searches: number }[]
  tasksFiled: number
  tasksFiledWithoutChecking: number
  recentMisses: string[]
}

export const readMemoryUseFor = async (userId: string, hours = 24): Promise<MemoryUse> => {
  const { data, error } = await admin().rpc('cairn_memory_use', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as MemoryUse
}

export const readVitalsFor = async (userId: string, hours = 24): Promise<Vitals> => {
  const { data, error } = await admin().rpc('cairn_vitals', { p_owner: userId, p_hours: hours })
  if (error) throw new Error(error.message)
  return data as unknown as Vitals
}

export const readVitals = (actor: Actor, hours = 24) => readVitalsFor(actor.userId, hours)

/**
 * The same read, cached, for the pages that show it.
 *
 * The aggregate takes ~45ms, which is fine once and wasteful on every
 * navigation — and a health summary five minutes stale is still a health
 * summary. The API route deliberately does not use this: a monitor asking the
 * question deserves the current answer.
 */
export const cachedVitals = (userId: string, hours = 24) =>
  unstable_cache(() => readVitalsFor(userId, hours), ['cairn-vitals', userId, String(hours)], {
    revalidate: 300,
  })()
