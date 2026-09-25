#!/usr/bin/env node
/**
 * Cairn's scheduled maintenance, as something you can read in a pull request.
 *
 * These jobs are OPTIONAL. Cairn works without any of them: they are the
 * difference between a tracker that notices its own problems and one that
 * waits to be asked. Install none, some, or all.
 *
 *   node scripts/install-cron.mjs            # print what would be installed
 *   node scripts/install-cron.mjs --install  # install it
 *   node scripts/install-cron.mjs --remove   # take it out again
 *   node scripts/install-cron.mjs --run agent-files   # run that job now
 *
 * Printing is the default on purpose: a script that edits a crontab the moment
 * it is run is a script nobody should run.
 *
 * cron on Linux, launchd on macOS. The jobs are defined once, as a schedule, an
 * environment and a command; each backend renders that. A second definition
 * would be a second thing to keep in step, which is the failure this file
 * exists to end — the jobs used to live only in the crontab on one box.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEGIN = '# >>> cairn maintenance (managed by scripts/install-cron.mjs)'
const END = '# <<< cairn maintenance'

const HERE = dirname(fileURLToPath(import.meta.url))

const env = (name, fallback) => process.env[name] ?? fallback

/** `--flag value` off the command line, or null if the flag is not there. */
const flagValue = (name) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1] ?? null
}

const MAC = process.platform === 'darwin'

/**
 * Defaults that describe the machine this is running on rather than one host.
 *
 * A Mac has no /usr/local/bin/cairn, cannot write /var/log as the logged-in
 * user, and keeps node wherever Homebrew or nvm put it — so the Linux defaults
 * made every job skip, correctly but uselessly.
 */
const firstPresent = (...paths) => paths.find((path) => existsSync(path)) ?? paths[paths.length - 1]

const CLI = env(
  'CAIRN_CLI_PATH',
  firstPresent(join(homedir(), '.local/bin/cairn'), '/usr/local/bin/cairn'),
)
// process.execPath is the node actually running this, which is the one that
// will still be there tomorrow. Pinned on Linux, where /usr/bin/node is what
// the installed crontabs already name.
const NODE = env('CAIRN_NODE_PATH', MAC ? process.execPath : '/usr/bin/node')
const LOGS = env('CAIRN_LOG_DIR', MAC ? join(homedir(), 'Library/Logs') : '/var/log')
const SYNC = env(
  'CAIRN_SYNC_SCRIPT',
  MAC
    ? join(homedir(), '.cairn/maintenance/sync-agent-files.mjs')
    : '/opt/cairn-maintenance/sync-agent-files.mjs',
)
const RAW = env('CAIRN_RAW_BASE', 'https://raw.githubusercontent.com/montytorr/cairn/main')
const HOOKS = env('CAIRN_HOOKS_DIR', join(homedir(), '.cairn/hooks'))

/** Where a runtime keeps transcripts nothing else will hand us. */
const OPENCLAW_SESSIONS = env('CAIRN_OPENCLAW_SESSIONS', '')

/**
 * How the sweep reaches a summariser, when the identity it must run as cannot.
 *
 * The OpenClaw sweep has to be root — the transcripts live under a 0700 home —
 * and `claude -p` as root answered "Not logged in". The hook swallows a failed
 * summariser so as not to lose the session row, so every OpenClaw session was
 * recorded with its files and refs and no prose at all, silently, for the life
 * of the feature. Point this at a wrapper that can summarise.
 */
const SUMMARY_CLI = env('CAIRN_SUMMARY_CLI', '')

/** Tasks the jobs report into. Empty disables reporting for that job. */
const NOTIFY_FILES = env('CAIRN_NOTIFY_FILES', '')
const NOTIFY_VITALS = env('CAIRN_NOTIFY_VITALS', '')

/** Extra copies outside this user's home, as `artefact=path`, comma separated. */
const ALSO = env('CAIRN_SYNC_ALSO', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const log = (name) => join(LOGS, `cairn-${name}.log`)

/**
 * Whether the CLI the jobs will run knows --all-instances. Read from the file,
 * not run: an older copy refuses the flag as unknown and exits 2 on every
 * run, and the copy is only brought up to date by the agent-files job, which
 * may not have caught up yet when this installer is run from a fresh checkout.
 */
const FANS_OUT = (() => {
  try {
    return readFileSync(CLI, 'utf8').includes("'all-instances'")
  } catch {
    return true // not installed yet; the copy that arrives will be current
  }
})()
const ALL_INSTANCES = FANS_OUT ? ['--all-instances'] : []
if (!FANS_OUT && existsSync(join(homedir(), '.cairn', 'instances.json'))) {
  console.error(
    `warning: ${CLI} predates --all-instances, so reconcile and vitals will reach one instance only. ` +
      'Run the agent-files job to update it, then run this installer again.',
  )
}

/**
 * The jobs, as schedule + environment + command.
 *
 * Rendered into a crontab line or a launchd plist below. Written this way so
 * the two backends cannot disagree about what a job actually is.
 */
const JOBS = [
  {
    name: 'reconcile',
    why: 'Releases claims an agent stopped working on, and moves the task back to todo.',
    requires: [CLI],
    every: 30,
    env: { CAIRN_AGENT: 'maintenance' },
    // One run per instance where a machine has several (README, "Several
    // instances"); exactly the old run where it has one.
    command: [CLI, 'reconcile', ...ALL_INSTANCES],
  },
  {
    name: 'vitals',
    why: 'Asks daily whether the memory is still being written, and says so only when it is not.',
    requires: [CLI],
    at: { hour: 8, minute: 0 },
    env: { CAIRN_AGENT: 'maintenance' },
    command: [CLI, 'vitals', ...ALL_INSTANCES, ...(NOTIFY_VITALS ? ['--notify', NOTIFY_VITALS] : [])],
  },
  {
    name: 'agent-files',
    why: 'Repairs the skill, CLI and hooks wherever a runtime reads a stale copy.',
    requires: [SYNC, NODE],
    at: { minute: 23 },
    /**
     * A laptop is not a server. The server is also repaired by every deploy
     * (CAIRN-257), so hourly is its fallback; a Mac has no such trigger, and
     * sleeps through slots, so an hourly job left it up to an hour and often
     * several behind every merge (CAIRN-290). launchd runs a missed calendar
     * slot on wake — StartInterval would drop it — so: more slots, and a run
     * at load, which is login and every reinstall.
     */
    launchd: { every: 15, runAtLoad: true },
    env: { CAIRN_AGENT: 'maintenance' },
    command: [
      NODE,
      SYNC,
      '--source',
      RAW,
      ...ALSO.flatMap((pair) => ['--also', pair]),
      ...(NOTIFY_FILES ? ['--notify', NOTIFY_FILES] : []),
    ],
  },
  {
    name: 'openclaw-sessions',
    why: 'OpenClaw has no session-end event, so its transcripts are swept instead.',
    requires: [OPENCLAW_SESSIONS, join(HOOKS, 'cairn-session-end.mjs'), NODE],
    every: 30,
    env: {
      CAIRN_AGENT: 'openclaw',
      CAIRN_PLATFORM: 'openclaw',
      ...(SUMMARY_CLI ? { CAIRN_SUMMARY_CLI: SUMMARY_CLI } : {}),
    },
    command: [NODE, join(HOOKS, 'cairn-session-end.mjs'), '--scan', OPENCLAW_SESSIONS],
  },
]

// Every N minutes, a daily time, or a minute past each hour.
const cronFields = (job) =>
  job.every
    ? `*/${job.every} * * * *`
    : `${job.at.minute ?? 0} ${job.at.hour ?? '*'} * * *`

const cronLine = (job) =>
  `${cronFields(job)} ` +
  Object.entries(job.env).map(([k, v]) => `${k}=${v}`).join(' ') +
  ` ${job.command.join(' ')} >> ${log(job.name)} 2>&1`

// ---------------------------------------------------------------------------
// launchd, for macOS. Same jobs, rendered as one agent per job.
//
// Not cron: macOS still has a crontab, but it is deprecated, it runs outside
// the user session where a job cannot reach the keychain or a per-user PATH,
// and it is subject to privacy prompts nobody is present to answer. A
// LaunchAgent runs as the logged-in user, which is whose files these are.
// ---------------------------------------------------------------------------

const LABEL = (name) => `com.cairn.${name}`
const AGENTS_DIR = join(homedir(), 'Library/LaunchAgents')
const plistPath = (name) => join(AGENTS_DIR, `${LABEL(name)}.plist`)

const xml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * launchd has no "every 30 minutes", only a list of times — so the interval is
 * expanded into the minutes it actually means.
 */
const calendar = (job) =>
  job.every
    ? Array.from({ length: Math.floor(60 / job.every) }, (_, i) => ({ Minute: i * job.every }))
    : [{ ...(job.at.hour === undefined ? {} : { Hour: job.at.hour }), Minute: job.at.minute ?? 0 }]

/**
 * A LaunchAgent inherits almost no environment, so the PATH a job needs has to
 * be stated. sync-agent-files reports by calling `cairn`, which is on nobody's
 * PATH under launchd.
 */
const jobPath = [dirname(CLI), dirname(NODE), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  .filter((dir, i, all) => all.indexOf(dir) === i)
  .join(':')

/** A job as launchd runs it: the same job, with its launchd-only differences. */
const forLaunchd = (job) => {
  const { launchd, ...rest } = job
  return launchd ? { ...rest, ...launchd, at: launchd.every ? undefined : rest.at } : rest
}

const plist = (base) => {
  const job = forLaunchd(base)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL(job.name)}</string>
  <key>ProgramArguments</key>
  <array>
${job.command.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(job.env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
    <key>PATH</key><string>${xml(jobPath)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${calendar(job)
  .map(
    (slot) =>
      `    <dict>${Object.entries(slot)
        .map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`)
        .join('')}</dict>`,
  )
  .join('\n')}
  </array>
  <key>StandardOutPath</key><string>${xml(log(job.name))}</string>
  <key>StandardErrorPath</key><string>${xml(log(job.name))}</string>
  <key>RunAtLoad</key>${job.runAtLoad ? '<true/>' : '<false/>'}
</dict>
</plist>
`
}

const launchctl = (args, { tolerate = false } = {}) => {
  try {
    execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch (error) {
    // bootout on something not loaded is the normal case on a first install.
    if (!tolerate) throw error
  }
}

const only = process.argv.includes('--only')
  ? (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')
  : null

const REMOVE = process.argv.includes('--remove')
const INSTALL = process.argv.includes('--install')
const USE_LAUNCHD = process.argv.includes('--launchd') || (MAC && !process.argv.includes('--cron'))

/** `--run <job>`, and the two differences a caller may make to it. See below. */
const RUN = flagValue('--run')
const RUN_SOURCE = flagValue('--source')
const RUN_WITHOUT_NOTIFY = process.argv.includes('--no-notify')

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

// ---------------------------------------------------------------------------
// --run <job>: run an installed job NOW, exactly as the schedule runs it.
//
// WHY. Cairn's code is push-based — merge to main, GitHub Actions deploys —
// while the files agents READ about that code are pull-based, repaired by the
// hourly `agent-files` job. The two clocks are independent, so after a merge
// that touches both there is a window in which every agent on every machine
// reads instructions that contradict the code already live. Measured on
// 2026-09-21: merge at 16:14, previous sync at 15:23, 51 minutes, and up to 59
// in the general case (CAIRN-257).
//
// So the deploy calls this the moment it has finished deploying. The schedule
// is NOT replaced and must not be: it is the fallback for a machine that was
// powered off, one the deploy cannot reach, and a merge that for any reason
// never got here. A trigger added, not a schedule removed — and a side effect
// worth having is that a repair reported by the hourly job now means something
// sharper than it did, namely that the trigger did not arrive.
//
// WHY IT READS THE COMMAND BACK OUT instead of rendering it again. The part
// that matters is host-specific: which copies this machine has (`--also
// skill=<another account's tree>`) lives in the line the installer wrote, and
// nowhere else. Rendering it a second time from the environment would work only
// where that environment is set, which is not where a CI job runs; writing it
// out a second time in a workflow file is the next thing to drift. The
// installed schedule is the source of truth, and this runs it early.
//
// Splitting the crontab line on whitespace is the exact inverse of how it was
// written (`job.command.join(' ')`, unquoted): a path containing a space would
// already have broken the line itself, so this parse is no weaker than that
// render. The LaunchAgent is read the same way, out of the plist this file
// wrote, so the two backends still cannot disagree about what a job is.
// ---------------------------------------------------------------------------

const unxml = (text) =>
  String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The job's line out of our own managed block in the running user's crontab. */
const scheduledInCron = (name) => {
  const lines = current().split('\n')
  const start = lines.indexOf(BEGIN)
  const end = lines.indexOf(END)
  if (start === -1 || end === -1 || end < start) return null

  const ours = lines.slice(start + 1, end)
  const at = ours.findIndex((line) => line.startsWith(`# ${name}:`))
  if (at === -1) return null
  const line = ours.slice(at + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  if (!line) return null

  const tokens = line.trim().split(/\s+/).slice(5) // five schedule fields
  const environment = {}
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const [key, ...rest] = tokens.shift().split('=')
    environment[key] = rest.join('=')
  }
  // `>> <log> 2>&1` is the crontab's own plumbing; here the output belongs to
  // whoever asked for the run.
  const redirect = tokens.findIndex((token) => token.startsWith('>') || token === '2>&1')
  const command = redirect === -1 ? tokens : tokens.slice(0, redirect)
  return command.length === 0 ? null : { environment, command }
}

/** The same job, out of the LaunchAgent this installer wrote. */
const scheduledInLaunchd = (name) => {
  const path = plistPath(name)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')

  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  const command = [...(args?.[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((match) => unxml(match[1]))

  const variables = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)
  const environment = {}
  for (const match of (variables?.[1] ?? '').matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    environment[unxml(match[1])] = unxml(match[2])
  }

  return command.length === 0 ? null : { environment, command }
}

/**
 * The only two differences between "on the hour" and "right after a deploy",
 * and there are deliberately only two — a third would be a second definition of
 * the job, which is what this whole mechanism exists to avoid.
 *
 * `--source` because a deploy has the exact tree it just deployed sitting on
 * disk, which is strictly better than the schedule's raw.githubusercontent URL:
 * that URL is served from a CDN with a cache of its own, so a fetch seconds
 * after the merge can be handed the previous main and write it back as though
 * it were current. Omit it and the scheduled source is used unchanged.
 *
 * `--no-notify` because the schedule's note means "a runtime was reading a
 * stale copy until now", which is a surprise worth recording. On the deploy
 * path a repair is the expected outcome of every merge that touches these
 * files, so a note per merge would bury the notes that mean something.
 */
const withRunOverrides = (command) => {
  const out = [...command]
  if (RUN_SOURCE) {
    const at = out.indexOf('--source')
    if (at === -1) out.push('--source', RUN_SOURCE)
    else out[at + 1] = RUN_SOURCE
  }
  if (RUN_WITHOUT_NOTIFY) {
    const at = out.indexOf('--notify')
    if (at !== -1) out.splice(at, 2)
  }
  return out
}

if (RUN) {
  if (INSTALL || REMOVE) {
    console.error('--run does one thing: run an installed job now.')
    console.error('It does not install and does not remove. Pick one.')
    process.exit(2)
  }

  const scheduled = USE_LAUNCHD ? scheduledInLaunchd(RUN) : scheduledInCron(RUN)
  if (!scheduled) {
    // Deliberately no fallback to rendering the job from JOBS. On a machine
    // where this is not installed, the environment that describes the machine
    // is not set either, so the job invented here would reach none of the
    // copies the real one reaches — and would report success for doing nothing.
    console.error(`No ${RUN} job is installed for ${MAC && USE_LAUNCHD ? 'this user' : 'this crontab'}.`)
    console.error('Install it first; there is nothing to fall back to on purpose,')
    console.error('because a job invented here would not be the job that is scheduled.')
    process.exit(3)
  }

  const command = withRunOverrides(scheduled.command)
  console.log(`# ${RUN}: ${command.join(' ')}`)
  try {
    execFileSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, ...scheduled.environment },
    })
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1)
  }
  process.exit(0)
}

/**
 * The repairer has to be somewhere stable before it can be scheduled: a job
 * pointed at a working tree breaks the first time the tree is moved or checked
 * out to a branch. On the server this directory was made by hand; doing it here
 * is what makes `--install` work on a machine that has never had it.
 */
const REPO_SYNC = join(HERE, 'sync-agent-files.mjs')
if (INSTALL && !existsSync(SYNC) && existsSync(REPO_SYNC)) {
  mkdirSync(dirname(SYNC), { recursive: true })
  copyFileSync(REPO_SYNC, SYNC)
  console.log(`placed ${SYNC}`)
}

const applicable = JOBS.filter((job) => {
  if (only && !only.includes(job.name)) return false
  // An empty requirement is one the environment never named — a job that was
  // not configured rather than one whose file is missing. Reported as itself,
  // because "no  on this machine" reads like a bug in the installer.
  const unset = job.requires.filter((path) => !path)
  if (unset.length > 0) {
    console.error(`# skipping ${job.name}: not configured on this machine`)
    return false
  }
  const missing = job.requires.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error(`# skipping ${job.name}: no ${missing[0]} on this machine`)
    return false
  }
  return true
})

const block = [BEGIN, ...applicable.flatMap((job) => [`# ${job.name}: ${job.why}`, cronLine(job)]), END]

if (!INSTALL && !REMOVE) {
  if (USE_LAUNCHD) {
    console.log(`# launchd — ${applicable.length} agent(s) in ${AGENTS_DIR}\n`)
    for (const job of applicable) console.log(`# ${job.name}: ${job.why}\n${plist(job)}`)
  } else {
    console.log(block.join('\n'))
  }
  console.log('\n# nothing written. --install to apply, --remove to take it out.')
  process.exit(0)
}

if (USE_LAUNCHD) {
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  const uid = process.getuid()

  // Every job in scope is torn down first, including on install: a plist that
  // changed under a loaded agent is not picked up, and the stale one goes on
  // running. In scope, because `--only agent-files` used to boot out every
  // other agent too and load back only the one named, leaving the rest
  // unloaded until the next login with their plists still on disk.
  for (const job of JOBS.filter((j) => !only || only.includes(j.name))) {
    launchctl(['bootout', `gui/${uid}/${LABEL(job.name)}`], { tolerate: true })
    if (REMOVE) rmSync(plistPath(job.name), { force: true })
  }

  if (REMOVE) {
    console.log(`removed ${only ? only.length : JOBS.length} agent(s) from ${AGENTS_DIR}`)
    process.exit(0)
  }

  for (const job of applicable) {
    writeFileSync(plistPath(job.name), plist(job), { mode: 0o644 })
    launchctl(['bootstrap', `gui/${uid}`, plistPath(job.name)])
    console.log(`loaded ${LABEL(job.name)}  (${job.name})`)
  }
  console.log(`installed ${applicable.length} agent(s); logs in ${LOGS}`)
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
