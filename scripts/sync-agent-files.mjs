#!/usr/bin/env node
/**
 * One copy of each agent-facing file, everywhere it has to live.
 *
 * The skill, the CLI and the two hooks are read from a directory per runtime,
 * so the same file exists four, five, six times across a laptop and a server.
 * They drift silently, and the drift is invisible until an agent behaves
 * differently from its siblings for reasons nobody can see. Both halves of
 * that bit in one day: a skill copy a day out of date, and a CLI three days
 * old that was still writing under the wrong identity — the very bug the day
 * had been spent fixing.
 *
 *   node scripts/sync-agent-files.mjs --check   # report drift, write nothing
 *   node scripts/sync-agent-files.mjs           # make every reachable copy match
 *
 * Targets that do not apply to this machine are skipped, not invented: a file
 * in a directory no runtime reads is worse than no file at all. The built-in
 * targets are this user's own; anything else — another user's home, a runtime
 * with a tree of its own — is named by `--also`, because which copies exist is
 * a fact about a machine rather than about Cairn.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

/**
 * Where the canonical files come from: a checkout, or the public repository.
 *
 * `--source <url>` is for the machine that has no checkout. raw.githubusercontent
 * cannot drift and is the same main branch the deploy already builds from.
 */
const SOURCE = arg('--source') ?? join(HERE, '..')

const home = homedir()

/** A target applies only if the directory its runtime reads already exists. */
const at = (path, needs) => ({ path, needs: needs ?? dirname(path) })

const ARTEFACTS = [
  {
    name: 'skill',
    file: 'skills/cairn/SKILL.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/SKILL.md'), join(home, '.claude')),
      at(join(home, '.codex/skills/cairn/SKILL.md'), join(home, '.codex')),
    ],
  },
  {
    name: 'cli',
    file: 'cli/cairn.mjs',
    mode: 0o755,
    // `needs` is the file itself: update a CLI where one is already installed,
    // never put a second one somewhere nobody asked for. /usr/local/bin exists
    // on every machine; that is not consent to install into it.
    targets: [
      at(join(home, '.local/bin/cairn'), join(home, '.local/bin/cairn')),
      at('/usr/local/bin/cairn', '/usr/local/bin/cairn'),
    ],
  },
  {
    // The repairer, which was the one file it never repaired. It is copied out
    // of the checkout to a stable path so a scheduled job does not depend on a
    // working tree that can be moved or checked out to a branch, and that copy
    // then goes stale exactly like every other copy here did.
    name: 'maintenance',
    file: 'scripts/sync-agent-files.mjs',
    mode: 0o755,
    targets: [
      at('/opt/cairn-maintenance/sync-agent-files.mjs', '/opt/cairn-maintenance/sync-agent-files.mjs'),
      at(
        join(home, '.cairn/maintenance/sync-agent-files.mjs'),
        join(home, '.cairn/maintenance/sync-agent-files.mjs'),
      ),
    ],
  },
  {
    /**
     * The MCP facade, which drifts for the same reason everything else here
     * does and was missed because it arrives by an installer rather than a
     * copy.
     *
     * It shipped at 19 tools, gained a twentieth the same day, and the
     * installed copy stayed at 19 — a runtime reading a facade a version
     * behind the CLI it is a facade OF, which is the exact failure this file
     * exists to prevent.
     *
     * Only `server.mjs`: the node_modules beside it is the installer's job and
     * changes only when the dependency does. `needs` is the file itself, so
     * this repairs an install and never creates one.
     */
    name: 'mcp',
    file: 'mcp/server.mjs',
    mode: 0o644,
    targets: [at('/opt/cairn-mcp/server.mjs', '/opt/cairn-mcp/server.mjs')],
  },
  {
    // And the installer beside it, for the same reason and by the same
    // argument. It was left out when the entry above was written, so it became
    // the one deployed copy that drifted -- while every other copy on that host
    // stayed identical, which is precisely the state that makes drift look
    // impossible. A file is only kept honest here if it is listed here.
    name: 'maintenance:cron',
    file: 'scripts/install-cron.mjs',
    mode: 0o755,
    targets: [
      at('/opt/cairn-maintenance/install-cron.mjs', '/opt/cairn-maintenance/install-cron.mjs'),
      at(
        join(home, '.cairn/maintenance/install-cron.mjs'),
        join(home, '.cairn/maintenance/install-cron.mjs'),
      ),
    ],
  },
  {
    name: 'hook:context',
    file: 'hooks/cairn-context.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.cairn/hooks/cairn-context.mjs')),
    ],
  },
  {
    name: 'hook:session-end',
    file: 'hooks/cairn-session-end.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.cairn/hooks/cairn-session-end.mjs')),
    ],
  },
]

/**
 * Copies outside this user's home, for a scheduled run that has to reach them.
 * `--also <artefact>=<path>`, repeatable. A machine's own layout belongs in the
 * job that runs this, not in a public repository.
 *
 * This is how every non-standard location is reached, and there are two common
 * ones: another user's home, when the job runs as root and the runtimes do not;
 * and a runtime that keeps its skills in a tree of its own rather than a
 * dotfile directory, which is the usual shape for a gateway-style runtime.
 * `CAIRN_SYNC_ALSO` on `install-cron.mjs` renders these into the scheduled job.
 */
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--also') continue
  const [name, path] = (process.argv[i + 1] ?? '').split('=')
  const artefact = ARTEFACTS.find((a) => a.name === name)
  if (artefact && path) artefact.targets.push(at(path))
}

const CHECK = process.argv.includes('--check')
const NOTIFY = arg('--notify')

/**
 * Said on every run, not only on the run that has something to report: a
 * missing key found only when a repair happens is found once a week, in the
 * one log line nobody is reading that day. Mirrors the CLI's rule — a split
 * ~/.cairn/env with no key for this identity means the report would be filed
 * as someone else, so the CLI refuses it.
 */
const identityProblem = () => {
  const agent = (process.env.CAIRN_AGENT ?? '').trim().toLowerCase()
  if (!NOTIFY || agent !== 'maintenance' || process.env.CAIRN_API_KEY) return null
  let names = []
  try {
    names = readFileSync(join(home, '.cairn/env'), 'utf8')
      .split('\n')
      .map((line) => line.trim().split('=')[0]?.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const split = names.some((name) => name.startsWith('CAIRN_API_KEY_'))
  if (!split || names.includes('CAIRN_API_KEY_MAINTENANCE')) return null
  return (
    `WARNING: CAIRN_AGENT=maintenance but ${join(home, '.cairn/env')} has no CAIRN_API_KEY_MAINTENANCE. ` +
    `Reports to ${NOTIFY} will be refused rather than filed under another runtime's key.`
  )
}
const IDENTITY_PROBLEM = identityProblem()
if (IDENTITY_PROBLEM) {
  console.log(IDENTITY_PROBLEM)
  process.exitCode = 1
}
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)

/**
 * A laptop wakes before its network does.
 *
 * launchd runs a missed calendar slot the moment the machine wakes, which is
 * exactly when DNS is not up yet: the Mac's log had 20 ENOTFOUND and 22
 * "fetch failed" runs, each one another hour on a stale CLI (CAIRN-290). So a
 * network error is retried for about a minute and a half before it counts. An
 * HTTP error is an answer, not an outage, and is not retried.
 */
const RETRY_DELAYS_MS = (process.env.CAIRN_SYNC_RETRY_MS ?? '5000,15000,30000,45000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0)

const fetchWithRetry = async (url) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url)
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw error
      const why = error.cause?.code ?? error.message
      console.log(`  (network: ${why}; retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s)`)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

const readSource = async (file) => {
  if (!/^https?:\/\//.test(SOURCE)) return readFileSync(join(SOURCE, file))
  const response = await fetchWithRetry(`${SOURCE.replace(/\/+$/, '')}/${file}`)
  if (!response.ok) throw new Error(`${file} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const repaired = []
let drifted = 0

for (const artefact of ARTEFACTS) {
  const source = await readSource(artefact.file)
  const canonical = hash(source)
  console.log(`\n${artefact.name}  ${canonical}  ${artefact.file}`)

  // A `--also` path can name a file a built-in target already covers — the
  // same file reported twice, the second time as already fine, which reads
  // like a copy that was never touched.
  const unique = artefact.targets.filter(
    (t, i) => artefact.targets.findIndex((o) => o.path === t.path) === i,
  )

  for (const target of unique) {
    if (!existsSync(target.needs)) {
      console.log(`  skipped   ${target.path}  (no ${target.needs} here)`)
      continue
    }

    const present = existsSync(target.path)
    const current = present ? hash(readFileSync(target.path)) : null
    if (current === canonical) {
      console.log(`  ok        ${target.path}`)
      continue
    }

    drifted += 1
    const state = present ? current : 'missing'
    if (CHECK) {
      console.log(`  DRIFT     ${target.path}  (${state})`)
      continue
    }

    try {
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, source)
      chmodSync(target.path, artefact.mode)
      repaired.push(`${artefact.name}: ${target.path} (was ${state})`)
      console.log(`  updated   ${target.path}  ${state} -> ${canonical}`)
    } catch (error) {
      console.log(`  FAILED    ${target.path}  (${error.code ?? error.message})`)
    }
  }
}

/**
 * Silence when nothing moved, a record when something did. A scheduled repair
 * that never says anything is indistinguishable from one that is not running,
 * and one that reports every hour trains everybody to ignore it.
 */
if (NOTIFY && repaired.length > 0) {
  const note =
    `Agent files repaired on ${process.env.HOSTNAME ?? 'this host'} ` +
    `(${repaired.length} cop${repaired.length === 1 ? 'y' : 'ies'}):\n` +
    repaired.map((line) => `  ${line}`).join('\n') +
    `\n\nEach was being read by a runtime in that state until now.`
  // stderr is kept, not thrown away. It is where the CLI says whose key it is
  // using, and discarding it hid for weeks that a scheduled job with
  // CAIRN_AGENT=maintenance and no maintenance key was filing its reports as
  // another runtime (CAIRN-290). The CLI now refuses that outright; this is
  // what makes the refusal reach the log, and the exit code the scheduler.
  const said = (text) =>
    String(text ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => `  cairn: ${line.replace(/^cairn: /, '')}`)
  try {
    const stderr = execFileSync('cairn', ['note', NOTIFY, note, '--kind', 'note'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
    console.log(`\nreported to ${NOTIFY}`)
    for (const line of said(stderr)) console.log(line)
  } catch (error) {
    console.log(`\nCOULD NOT REPORT to ${NOTIFY} (exit ${error.status ?? error.code ?? '?'})`)
    for (const line of said(error.stderr)) console.log(line)
    process.exitCode = 1
  }
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}
