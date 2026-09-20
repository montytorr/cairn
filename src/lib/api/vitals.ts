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
  sessions: {
    recent: number
    recentWithFiles: number
    /** Sessions whose prose half was actually written by the summariser. */
    recentSummarised: number
    baseline: number
    baselineWithFiles: number
  }
  tasks: { opened: number; closed: number; stalled: number; held: number }
  autoReleased: number
  knowledgeWritten: number
  /**
   * Everyone who wrote, people included — the panel this feeds is called
   * "Who wrote", and a person writing ninety-seven times a week is a true
   * answer to that. `actorType` is what lets the checks below tell them apart.
   */
  agents: { agent: string; actorType?: 'human' | 'agent'; recent: number; baseline: number }[]
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
  //
  // It used to end "The session hooks are not running, or cannot write," and
  // that sentence was wrong both times it mattered. Once the runtimes were out
  // of tokens, so there was nothing to record and every hook was fine. Once the
  // hooks fired, the key authenticated and the parser worked — but the sessions
  // had been open for two days and the only trigger was SessionEnd, which had
  // not come. Both times the guess was read as the diagnosis and cost an hour.
  //
  // A count of zero cannot distinguish a runtime with nothing to say from one
  // that cannot speak. So say what was seen, and name the one command that
  // tells them apart.
  if (v.sessions.recent === 0 && expected(v.sessions.baseline) >= 1) {
    findings.push({
      code: 'no-sessions',
      severity: 'alarm',
      message:
        `No session recorded in ${hours}, against ${v.sessions.baseline} in the week before. ` +
        `That is the observation, not the cause: an idle runtime, a hook that never fired ` +
        `and a hook that could not write all produce it. ` +
        `cairn-session-end.mjs --dry-run <transcript> separates them.`,
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

  /**
   * Sessions recorded, none of them summarised.
   *
   * A session is two halves: the files and refs, taken from the transcript,
   * and the prose — what was asked, learned, completed, left — which costs a
   * model call. The hook deliberately swallows a failed summariser rather than
   * lose the row, which is right, and means the prose half can stop being
   * written without anything failing.
   *
   * It did. `claude -p` as root answered "Not logged in", the OpenClaw sweep
   * runs as root because the transcripts sit under a 0700 home, and 42 of 42
   * OpenClaw sessions were recorded with no prose at all for the life of the
   * feature. Nothing was broken enough to notice: the rows were there, the
   * counts were healthy, and every one of them was half a session.
   */
  if (v.sessions.recent >= 3 && v.sessions.recentSummarised === 0) {
    findings.push({
      code: 'sessions-without-summary',
      severity: 'alarm',
      message:
        `${v.sessions.recent} sessions recorded in ${hours} and not one was summarised. ` +
        `The summariser is failing silently — the hook keeps the row when it cannot ` +
        `reach one, so this is the only place it shows.`,
    })
  }

  // Historical activity does not mean a runtime is expected to be active in
  // every window. In particular, direct Codex may be idle while OpenClaw
  // (which can run Codex underneath it) and Claude Code continue writing.
  // Keep this as a qualified warning, not an alarm: silence is a prompt to
  // verify runtime usage, never proof that hooks or keys are broken.
  for (const agent of v.agents) {
    /**
     * People are not runtimes.
     *
     * `actorLabel` gives a human their display name unqualified, so the owner
     * of this instance arrived here as `monty.torr@gmail.com` and was told he
     * had written nothing in 24h against 97 the week before — 97 being a week
     * of his own clicks — and advised to go and investigate his hooks and
     * keys. He has neither.
     *
     * Undefined is treated as a runtime on purpose: a payload from a server
     * that predates the column is all runtimes as far as anybody knew, and
     * silently dropping every check is worse than the false positive this
     * removes.
     */
    if (agent.actorType === 'human') continue
    if (agent.recent === 0 && expected(agent.baseline) >= 3) {
      findings.push({
        code: 'agent-silent',
        severity: 'warning',
        message:
          `${agent.agent} has written nothing in ${hours}, against ${agent.baseline} in the week ` +
          `before. This may simply be an idle runtime; verify it was expected to be active ` +
          `before investigating hooks or keys.`,
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
  widened: number
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
