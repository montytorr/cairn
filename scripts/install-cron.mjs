#!/usr/bin/env node
/**
 * Cairn's scheduled maintenance, as something you can read in a pull request.
 *
 * These jobs are OPTIONAL. Cairn works without any of them: they are the
 * difference between a tracker that notices its own problems and one that
 * waits to be asked. Install none, some, or all.
 *
 *   node scripts/install-cron.mjs            # print the block, change nothing
 *   node scripts/install-cron.mjs --install  # write it into the crontab
 *   node scripts/install-cron.mjs --remove   # take it out again
 *
 * Printing is the default on purpose: a script that edits a crontab the moment
 * it is run is a script nobody should run.
 *
 * Cairn's lines live between two markers and the installer only ever touches
 * what is between them. The manual edits these replace filtered the crontab by
 * grepping for the previous command, which worked and was one bad pattern away
 * from dropping eighteen lines of unrelated scheduling.
 *
 * Host-specific paths come from the environment, because a machine's layout
 * does not belong in a public repository. Any job whose prerequisites are not
 * present on this machine is skipped rather than installed broken.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BEGIN = '# >>> cairn maintenance (managed by scripts/install-cron.mjs)'
const END = '# <<< cairn maintenance'

const env = (name, fallback) => process.env[name] ?? fallback

const CLI = env('CAIRN_CLI_PATH', '/usr/local/bin/cairn')
const NODE = env('CAIRN_NODE_PATH', '/usr/bin/node')
const LOGS = env('CAIRN_LOG_DIR', '/var/log')
const SYNC = env('CAIRN_SYNC_SCRIPT', '/opt/cairn-maintenance/sync-agent-files.mjs')
const RAW = env('CAIRN_RAW_BASE', 'https://raw.githubusercontent.com/montytorr/cairn/main')
const HOOKS = env('CAIRN_HOOKS_DIR', join(homedir(), '.cairn/hooks'))

/** Where a runtime keeps transcripts nothing else will hand us. */
const OPENCLAW_SESSIONS = env('CAIRN_OPENCLAW_SESSIONS', '/root/.openclaw/agents/main/agent/codex-home/sessions')

/** Tasks the jobs report into. Empty disables reporting for that job. */
const NOTIFY_FILES = env('CAIRN_NOTIFY_FILES', '')
const NOTIFY_VITALS = env('CAIRN_NOTIFY_VITALS', '')

/** Extra copies outside this user's home, as `artefact=path`, comma separated. */
const ALSO = env('CAIRN_SYNC_ALSO', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const log = (name) => `>> ${LOGS}/cairn-${name}.log 2>&1`

const JOBS = [
  {
    name: 'reconcile',
    why: 'Releases claims an agent stopped working on, and moves the task back to todo.',
    requires: [CLI],
    line: `*/30 * * * * CAIRN_AGENT=maintenance ${CLI} reconcile ${log('reconcile')}`,
  },
  {
    name: 'vitals',
    why: 'Asks daily whether the memory is still being written, and says so only when it is not.',
    requires: [CLI],
    line:
      `0 8 * * * CAIRN_AGENT=maintenance ${CLI} vitals` +
      `${NOTIFY_VITALS ? ` --notify ${NOTIFY_VITALS}` : ''} ${log('vitals')}`,
  },
  {
    name: 'agent-files',
    why: 'Repairs the skill, CLI and hooks wherever a runtime reads a stale copy.',
    requires: [SYNC, NODE],
    line:
      `23 * * * * CAIRN_AGENT=maintenance ${NODE} ${SYNC} --source ${RAW}` +
      ALSO.map((pair) => ` --also ${pair}`).join('') +
      `${NOTIFY_FILES ? ` --notify ${NOTIFY_FILES}` : ''} ${log('agent-files')}`,
  },
  {
    name: 'openclaw-sessions',
    why: 'OpenClaw has no session-end event, so its transcripts are swept instead.',
    requires: [OPENCLAW_SESSIONS, join(HOOKS, 'cairn-session-end.mjs'), NODE],
    line:
      `*/30 * * * * CAIRN_AGENT=openclaw CAIRN_PLATFORM=openclaw ${NODE} ` +
      `${join(HOOKS, 'cairn-session-end.mjs')} --scan ${OPENCLAW_SESSIONS} ${log('openclaw-sessions')}`,
  },
]

const only = process.argv.includes('--only')
  ? (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')
  : null

const applicable = JOBS.filter((job) => {
  if (only && !only.includes(job.name)) return false
  const missing = job.requires.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error(`# skipping ${job.name}: no ${missing[0]} on this machine`)
    return false
  }
  return true
})

const block = [BEGIN, ...applicable.flatMap((job) => [`# ${job.name}: ${job.why}`, job.line]), END]

const current = () => {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8' })
  } catch {
    return '' // no crontab yet is not an error
  }
}

/** Everything that is not ours, with our block cut out wherever it sits. */
const withoutOurs = (text) => {
  const lines = text.split('\n')
  const start = lines.indexOf(BEGIN)
  const end = lines.indexOf(END)
  if (start === -1 || end === -1 || end < start) return lines
  return [...lines.slice(0, start), ...lines.slice(end + 1)]
}

const REMOVE = process.argv.includes('--remove')
const INSTALL = process.argv.includes('--install')

if (!INSTALL && !REMOVE) {
  console.log(block.join('\n'))
  console.log('\n# nothing written. --install to apply, --remove to take it out.')
  process.exit(0)
}

const existing = current()

// A crontab is somebody's scheduling, and this rewrites the whole of it.
const backup = join(homedir(), `crontab.bak-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)
writeFileSync(backup, existing, { mode: 0o600 })
console.log(`backed up to ${backup}`)

/** `crontab -l` ends in a newline, so the split leaves a trailing empty line.
 *  Cutting our block out of the middle moved that empty line up against the
 *  block we then appended, and one blank line was added on every run. */
const trimEnd = (lines) => {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

const kept = trimEnd(withoutOurs(existing))
const next = trimEnd(REMOVE ? kept : [...kept, ...block])

execFileSync('crontab', ['-'], { input: `${next.join('\n')}\n` })
console.log(REMOVE ? 'removed' : `installed ${applicable.length} job(s)`)
