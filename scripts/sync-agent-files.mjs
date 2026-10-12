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
 *   node sync-agent-files.mjs --source release  # from the release the instance runs
 *
 * Targets that do not apply to this machine are skipped, not invented: a file
 * in a directory no runtime reads is worse than no file at all. The built-in
 * targets are this user's own; anything else — another user's home, a runtime
 * with a tree of its own — is named by `--also`, because which copies exist is
 * a fact about a machine rather than about Cairn.
 *
 * What this writes is code every agent session on the machine then runs, with
 * that user's rights, so where it comes from is the whole security question
 * (issue #110). A scheduled run syncs from the release the connected instance
 * reports (`--source release`), never from a branch that any push can move.
 *
 * That includes its own two scripts. They used to be left to `cairn setup`, so
 * a machine whose copy predated an artefact never learned the artefact existed
 * (`lab.md`, missing on the Mac from 0.22.0 until setup was run again, CAIRN-390).
 * They are now fetched and verified like everything else, swapped in atomically,
 * and the run is repeated once by the new copy, which is the one that knows the
 * new artefacts. See `verifyScript` and the end of this file.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const home = homedir()

/**
 * `--runtimes claude-code,codex`: the runtimes `cairn setup` was told to set
 * up. A target that belongs to one not listed is left alone even where its
 * directory exists — a ~/.codex that is there for some other reason is not a
 * request for Cairn's skill, and the issue that found this had exactly that:
 * `--runtimes claude-code`, no Codex key, and a Codex skill written anyway.
 * Absent, every target whose directory exists applies, as it always has.
 */
const RUNTIMES = arg('--runtimes')
  ? new Set(arg('--runtimes').split(',').map((r) => r.trim()).filter(Boolean))
  : null

/** A target applies only if the directory its runtime reads already exists. */
const at = (path, needs, runtime) => ({ path, needs: needs ?? dirname(path), runtime })

/**
 * Codex reads `~/.agents/skills` (current) and `$CODEX_HOME/skills`
 * (deprecated, still loaded), and merges the two roots by path, not by name:
 * a skill in both is listed twice. So Codex gets the current root only, and
 * the copy this file used to keep in the deprecated one is retired once the
 * current one is in place (CAIRN-402).
 *
 * Except in a home OpenClaw also uses. Its Codex harness may discover a shared
 * `$HOME/.agents/skills`, and OpenClaw already has the skill from its own tree
 * (`--also skill=$CLAWD_HOME/skills/cairn/SKILL.md`), so writing there lists
 * it twice for OpenClaw. Such a home keeps Codex at `~/.codex/skills`, as before,
 * and retires nothing. The same test as `cairn setup`: openclaw among the
 * runtimes, `CLAWD_HOME` set, or a gateway copy of the skill named by `--also`.
 */
const OPENCLAW_SHARES_HOME =
  RUNTIMES?.has('openclaw') ||
  Boolean(process.env.CLAWD_HOME?.trim()) ||
  process.argv.some((a, i) => a === '--also' && (process.argv[i + 1] ?? '').startsWith('skill='))
const CODEX_SKILLS = join(home, OPENCLAW_SHARES_HOME ? '.codex/skills/cairn' : '.agents/skills/cairn')
const RETIRED_CODEX_SKILL = OPENCLAW_SHARES_HOME
  ? []
  : ['SKILL.md', 'lab.md', 'reference.md'].map((name) => join(home, '.codex/skills/cairn', name))
const CODEX_SKILL_HOME = join(CODEX_SKILLS, 'SKILL.md')

const ARTEFACTS = [
  {
    name: 'skill',
    file: 'skills/cairn/SKILL.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/SKILL.md'), join(home, '.claude'), 'claude-code'),
      at(CODEX_SKILL_HOME, join(home, '.codex'), 'codex'),
    ],
  },
  {
    // The Lab's workflow, which SKILL.md points at and which is kept out of it
    // so that an instance without the Lab does not pay for it in every session.
    // Beside the skill it belongs to: `needs` is the skill's own folder, so it
    // is repaired where the skill was installed and never creates one.
    name: 'skill:lab',
    file: 'skills/cairn/lab.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/lab.md'), join(home, '.claude/skills/cairn'), 'claude-code'),
      at(join(CODEX_SKILLS, 'lab.md'), CODEX_SKILLS, 'codex'),
    ],
  },
  {
    // The reference SKILL.md points at, read on demand so the core stays small
    // enough for every runtime's limit. Placed exactly like `skill:lab`.
    name: 'skill:reference',
    file: 'skills/cairn/reference.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/reference.md'), join(home, '.claude/skills/cairn'), 'claude-code'),
      at(join(CODEX_SKILLS, 'reference.md'), CODEX_SKILLS, 'codex'),
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
    //
    // `self`: a script, not data. It is verified as one before it is written
    // (`verifyScript`), and a failure to update it is loud rather than a
    // refusal of the whole run (`selfProblems`).
    name: 'maintenance',
    file: 'scripts/sync-agent-files.mjs',
    mode: 0o755,
    self: true,
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
    self: true,
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
  {
    name: 'hook:learn-nudge',
    file: 'hooks/cairn-learn-nudge.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.cairn/hooks/cairn-learn-nudge.mjs')),
    ],
  },
  /**
   * OpenClaw's bootstrap hook, which install-hooks.mjs copies here and links
   * with `openclaw hooks install --link`. A linked directory is read in place,
   * so keeping this copy current is the whole upgrade — bar a gateway restart,
   * which is OpenClaw's to do. `needs` is the hook's own directory: repaired
   * where it was installed, never created. `--also hook:openclaw-briefing=…`
   * (and `hook:openclaw-briefing-doc=…`) reaches a gateway run as another user.
   */
  {
    name: 'hook:openclaw-briefing',
    file: 'hooks/openclaw/cairn-briefing/handler.ts',
    mode: 0o644,
    targets: [at(join(home, '.cairn/hooks/openclaw/cairn-briefing/handler.ts'))],
  },
  {
    name: 'hook:openclaw-briefing-doc',
    file: 'hooks/openclaw/cairn-briefing/HOOK.md',
    mode: 0o644,
    targets: [at(join(home, '.cairn/hooks/openclaw/cairn-briefing/HOOK.md'))],
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
  // The skill is a folder: a copy of SKILL.md somewhere else (a gateway's own
  // tree) takes its lab.md and reference.md along, with no second `--also` to remember.
  if (name === 'skill' && path && basename(path) === 'SKILL.md') {
    ARTEFACTS.find((a) => a.name === 'skill:lab').targets.push(at(join(dirname(path), 'lab.md')))
    ARTEFACTS.find((a) => a.name === 'skill:reference').targets.push(at(join(dirname(path), 'reference.md')))
  }
}

const CHECK = process.argv.includes('--check')
const NOTIFY = arg('--notify')
/**
 * `personal:CAIRN-107` on a machine with several Cairn instances: the task is
 * on one of them, and a scheduled job has no directory to route by.
 */
const [NOTIFY_INSTANCE, NOTIFY_REF] = NOTIFY?.includes(':')
  ? [NOTIFY.slice(0, NOTIFY.indexOf(':')), NOTIFY.slice(NOTIFY.indexOf(':') + 1)]
  : [null, NOTIFY]
const SEVERAL_INSTANCES = existsSync(join(home, '.cairn', 'instances.json'))
const ENV_FILE = NOTIFY_INSTANCE ? join(home, '.cairn', 'instances', NOTIFY_INSTANCE, 'env') : join(home, '.cairn/env')

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
  if (SEVERAL_INSTANCES && !NOTIFY_INSTANCE) {
    return `WARNING: this machine has several Cairn instances (~/.cairn/instances.json) and --notify ${NOTIFY} ` +
      `does not say which one ${NOTIFY} is on. Write it as <instance>:${NOTIFY}.`
  }
  let names = []
  try {
    names = readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim().split('=')[0]?.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const split = names.some((name) => name.startsWith('CAIRN_API_KEY_'))
  if (!split || names.includes('CAIRN_API_KEY_MAINTENANCE')) return null
  return (
    `WARNING: CAIRN_AGENT=maintenance but ${ENV_FILE} has no CAIRN_API_KEY_MAINTENANCE. ` +
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
      // Bounded per attempt: a server that accepts the connection and never
      // answers would otherwise hold a scheduled run open until the next one.
      return await fetch(url, { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw error
      const why = error.cause?.code ?? error.message
      console.log(`  (network: ${why}; retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s)`)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

/**
 * The run stops here, before a single file is touched, and says why.
 *
 * Every way of not knowing what to install ends in this one place, and none of
 * them falls back to anything: a sync that cannot say which release it should
 * be installing and installs *something* anyway is the exact failure #110 is
 * about. Exit 1, so launchd, cron and `--run` all see a job that did not do
 * its work — the copies stay as they were, which is stale at worst.
 */
const refuse = (why) => {
  console.log(`\nNOT SYNCED: ${why}`)
  console.log('Nothing was written. The copies on this machine are unchanged.')
  process.exit(1)
}

const DEFAULT_REPO = 'https://raw.githubusercontent.com/montytorr/cairn'

/**
 * The URL every scheduled job was rendered with before #110.
 *
 * A job keeps its command line until `cairn setup` runs again, but the script
 * that command names is replaced by the very sync it runs — so the first run
 * of this file on such a machine is the one chance to stop following `main`
 * without waiting for anybody to re-run anything. It is read as `release`.
 * Following a branch is still possible, on purpose: `CAIRN_RAW_BASE` on the
 * installer renders `--unpinned` beside it, and nothing else does.
 */
const LEGACY_MAIN = `${DEFAULT_REPO}/main`
const UNPINNED = process.argv.includes('--unpinned')

/**
 * Where the tags live: `--repo`, else CAIRN_RAW_REPO, else the public
 * repository. A mirror only has to serve the same paths under `v<version>/`.
 *
 * https only, bar loopback. What comes back from here is run by every agent
 * session on the machine, so a plain-http base would hand that to anyone on
 * the path between the two.
 */
const repoBase = () => {
  const given = (arg('--repo') ?? process.env.CAIRN_RAW_REPO ?? DEFAULT_REPO).replace(/\/+$/, '')
  let url
  try {
    url = new URL(given)
  } catch {
    return refuse(`--repo ${given} is not a URL`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return refuse(`--repo ${given} is not https — release files are code, and are not fetched in the clear`)
  }
  if (url.search || url.hash || url.username || url.password) {
    return refuse(`--repo ${given} carries a query, fragment or credentials; give the bare base URL`)
  }
  return given
}

/**
 * A release number as the server's package.json spells it, and nothing else:
 * it is about to become a path segment in a URL whose answer is executed, so
 * `main`, `../x`, `1.2.3/../../evil` or an empty string must never get there.
 */
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

const envFile = (path) => {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
    )
  } catch {
    return {}
  }
}

/**
 * Every instance this machine talks to.
 *
 * One instance: the CAIRN_BASE_URL the CLI itself would use — the environment,
 * then ~/.cairn/env. Several (~/.cairn/instances.json): all of them, default or
 * not — see `newest` for why the default does not decide.
 */
const instances = () => {
  const path = join(home, '.cairn', 'instances.json')
  if (!existsSync(path)) {
    const url = process.env.CAIRN_BASE_URL || envFile(join(home, '.cairn/env')).CAIRN_BASE_URL
    return url
      ? [{ name: 'this machine\'s instance', url }]
      : refuse('no instance to pin to — no CAIRN_BASE_URL in ~/.cairn/env. Run `cairn setup --url <instance>`.')
  }
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return refuse(`~/.cairn/instances.json is not valid JSON (${error.message})`)
  }
  const all = Object.entries(config?.instances ?? {})
    .filter(([, instance]) => typeof instance?.url === 'string')
    .map(([name, instance]) => ({ name, url: instance.url }))
  return all.length ? all : refuse('~/.cairn/instances.json names no instance with a url')
}

/**
 * What `/api/v1/health` says the instance runs, or why it could not say.
 * No key: it is the liveness probe. Never refuses on its own — one instance
 * that cannot be asked is not a reason to ignore the others.
 */
const releaseOf = async ({ name, url }) => {
  const health = `${url.replace(/\/+$/, '')}/api/v1/health`
  let version
  try {
    const response = await fetchWithRetry(health)
    if (!response.ok) return { name, error: `${health} answered ${response.status}` }
    version = (await response.json())?.data?.version
  } catch (error) {
    return { name, error: `could not ask ${health} (${error.cause?.code ?? error.message})` }
  }
  if (typeof version !== 'string' || !RELEASE.test(version)) {
    return { name, error: `${health} reports version ${JSON.stringify(version)}, which is not a release number` }
  }
  return { name, version }
}

/** Ordered by major.minor.patch; a pre-release sorts below its release. */
const compareReleases = (a, b) => {
  const [coreA, preA] = a.split('-')
  const [coreB, preB] = b.split('-')
  const partsA = coreA.split('.').map(Number)
  const partsB = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i]
  if (!preA || !preB) return (preA ? -1 : 0) - (preB ? -1 : 0)
  return preA < preB ? -1 : preA > preB ? 1 : 0
}

/**
 * The newest release any instance this machine talks to reports.
 *
 * There is one CLI and one set of hooks per machine, whatever the number of
 * instances, so one release has to serve all of them. Requiring them to agree
 * left a machine on two instances at different releases — a personal one on
 * 0.14.0 beside a company one on 0.12.1 — refusing every run, forever. Following
 * the default instead made that choice by accident: a default on the older one
 * put a CLI behind the newer server, the direction that breaks (a missing
 * command), rather than ahead of the older one, which the CLI already expects
 * and says so ("newer than the server"). So: the newest.
 *
 * An instance that cannot be asked — a company instance behind a VPN, from
 * home — is left out rather than failing the run; the run refuses only when no
 * instance answers. This widens nothing: the version only picks a tag of the
 * repository above, and only instances this machine was set up for have a say.
 */
const newest = (answers) => {
  const known = answers.filter((a) => a.version)
  for (const { name, error } of answers.filter((a) => a.error)) console.log(`skipped   ${name}: ${error}`)
  if (!known.length) {
    refuse(`no instance said which release it runs (${answers.map((a) => `${a.name}: ${a.error}`).join('; ')})`)
  }
  return known.reduce((best, a) => (compareReleases(a.version, best.version) > 0 ? a : best))
}

/**
 * Where the canonical files come from, and whether that is the network.
 *
 *   (no --source)          the checkout this script sits in
 *   --source <dir>         a checkout or a deploy's tree, on disk
 *   --source release       the tag of the release the instance runs, under --repo
 *   --source <url>         exactly that base; `--unpinned` says a branch is meant
 *
 * `release` is what `cairn setup` schedules. It used to be `main`, fetched every
 * fifteen minutes and written over the CLI, the hooks every session runs, and
 * this script (#110): any commit upstream — or a bad push, or a compromised
 * account — ran on every connected machine within the quarter hour, unreviewed
 * and unpinned. A machine should run the code of the server it talks to and
 * nothing else, the server already says which release that is, and a tag is
 * the one ref a push to main does not move.
 */
const resolveSource = async () => {
  const given = arg('--source')
  if (!given) return join(HERE, '..')
  const legacy = given.replace(/\/+$/, '') === LEGACY_MAIN && !UNPINNED
  if (given !== 'release' && !legacy) return given
  if (legacy) console.log(`--source ${LEGACY_MAIN} is the pre-#110 default; pinning to the instance's release instead`)

  const repo = repoBase()
  const answers = await Promise.all(instances().map(releaseOf))
  const { name, version } = newest(answers)
  const others = answers.filter((a) => a.version && a.name !== name).map((a) => `${a.name} ${a.version}`)
  console.log(`release   v${version} (${name}${others.length ? `; also ${others.join(', ')}` : ''})`)
  return `${repo}/v${version}`
}

const SOURCE = await resolveSource()

const REMOTE = /^https?:\/\//.test(SOURCE)
console.log(`source    ${SOURCE}`)

/**
 * Set by the run that swapped this script, for the run it starts, and by
 * nobody else. The new copy leaves the maintenance scripts alone rather than
 * fetching them a second time: one swap per run, so a source that answers
 * differently on every fetch cannot turn this into a loop.
 */
const REEXEC = process.env.CAIRN_SYNC_REEXEC === '1'

const readSource = async (file) => {
  if (!REMOTE) return readFileSync(join(SOURCE, file))
  const response = await fetchWithRetry(`${SOURCE.replace(/\/+$/, '')}/${file}`)
  if (!response.ok) throw new Error(`${file} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * What a maintenance script has to be before it may replace the one that is
 * running: a node program that parses. Null when it is, otherwise why not.
 *
 * Where it came from is settled before it gets here — the tag of the release
 * the instance reports, over https, by the same code and from the same place
 * as the CLI and the hooks that every session on this machine already runs
 * from it (#110). There is no second channel to check a script against, so
 * this does not claim to authenticate one. It stops what the transport cannot:
 * a mirror that answers 200 for a path it does not have, a wrong or truncated
 * file, a release whose script does not parse and would leave the machine
 * with no repairer at all.
 */
const verifyScript = (buffer) => {
  if (buffer.length === 0 || buffer.length > 2_000_000) return `is ${buffer.length} bytes`
  if (!buffer.subarray(0, 64).toString('utf8').startsWith('#!/usr/bin/env node')) return 'is not a node script'
  const directory = mkdtempSync(join(tmpdir(), 'cairn-sync-verify-'))
  try {
    const file = join(directory, 'script.mjs')
    writeFileSync(file, buffer)
    const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 20_000 })
    if (parsed.status === 0) return null
    const why = String(parsed.stderr ?? '').split('\n').find((line) => /Error/.test(line))
    return `does not parse (${why?.trim() ?? parsed.error?.code ?? `exit ${parsed.status}`})`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Trouble with the maintenance scripts, kept apart from the run's refusals.
 *
 * Every other file is all-or-none (below), because a machine on two releases
 * at once is what that rule is for. A script that cannot be fetched or does
 * not verify is different: nothing is half-installed, the copy on disk is the
 * old one and still works, and refusing the CLI, the skill and the hooks
 * because the repairer's own update failed would only make a stale machine
 * staler. So the rest is synced and the run exits 1 saying why, every time,
 * until it is fixed — which is what a job that cannot update itself should
 * look like in a log (CAIRN-390).
 */
const selfProblems = []
const selfProblem = (artefact, why) => {
  selfProblems.push(`${artefact.name}: ${artefact.file} ${why}`)
  process.exitCode = 1
}

/**
 * Every file is read before any is written. One that cannot be fetched — a tag
 * the mirror never got, a CDN hiccup halfway down the list — used to throw
 * after the files before it had been replaced, leaving a machine on two
 * releases at once. Now it is all of them or none.
 */
const sources = new Map()
for (const artefact of ARTEFACTS) {
  if (artefact.self && REEXEC) continue
  try {
    const content = await readSource(artefact.file)
    const rejected = artefact.self ? verifyScript(content) : null
    if (rejected) selfProblem(artefact, `from ${SOURCE} ${rejected}`)
    else sources.set(artefact.name, content)
  } catch (error) {
    const why = `${error.cause?.code ?? error.code ?? error.message}`
    if (artefact.self) selfProblem(artefact, `could not be read from ${SOURCE} (${why})`)
    else refuse(`could not read ${artefact.file} from ${SOURCE} (${why})`)
  }
}

/**
 * Written beside the file it replaces and renamed over it, so a reader — the
 * scheduler starting the next run, an agent running the CLI — sees the old
 * file or the new one and never half of either, and a run that dies halfway
 * leaves the old copy.
 *
 * The owner of a file that is there is kept: a root-run job must not hand a
 * user's script to root. So is the mode, for the scripts (`keepMode`), which
 * are run by whoever owns them and must not lose their execute bit or gain a
 * wider one. Where the directory refuses a new file but the file itself can be
 * written, it is written in place, as every write here was before.
 */
const install = (path, content, mode, keepMode) => {
  const present = existsSync(path)
  // Through a symlink, not over it: the link is somebody's arrangement.
  const real = present ? realpathSync(path) : path
  if (!present) mkdirSync(dirname(real), { recursive: true })
  const reference = statSync(present ? real : dirname(path))
  const finalMode = present && keepMode ? reference.mode & 0o7777 : mode
  const extension = extname(real)
  const temporary = join(dirname(real), `.${basename(real, extension)}.${process.pid}.tmp${extension}`)
  try {
    writeFileSync(temporary, content)
    chmodSync(temporary, finalMode)
    // A file that existed keeps its owner; a new one takes its directory's.
    if (process.getuid?.() === 0) chownSync(temporary, reference.uid, reference.gid)
    if (hash(readFileSync(temporary)) !== hash(content)) throw new Error('the temporary copy does not match')
    renameSync(temporary, real)
  } catch (error) {
    rmSync(temporary, { force: true })
    if (!present || !['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
    writeFileSync(real, content)
    chmodSync(real, finalMode)
  }
}

const repaired = []
const replacedSelf = []
let drifted = 0

for (const artefact of ARTEFACTS) {
  if (!sources.has(artefact.name)) {
    console.log(`\n${artefact.name}  ${artefact.file}`)
    console.log(
      REEXEC && artefact.self
        ? '  skipped   (refreshed by the run that started this one)'
        : '  NOT UPDATED  see SELF-UPDATE FAILED below',
    )
    continue
  }
  const source = sources.get(artefact.name)
  const canonical = hash(source)
  console.log(`\n${artefact.name}  ${canonical}  ${artefact.file}`)

  // A `--also` path can name a file a built-in target already covers — the
  // same file reported twice, the second time as already fine, which reads
  // like a copy that was never touched.
  const unique = artefact.targets.filter(
    (t, i) => artefact.targets.findIndex((o) => o.path === t.path) === i,
  )

  for (const target of unique) {
    if (RUNTIMES && target.runtime && !RUNTIMES.has(target.runtime)) {
      console.log(`  skipped   ${target.path}  (${target.runtime} was not set up here)`)
      continue
    }
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
      install(target.path, source, artefact.mode, artefact.self)
      repaired.push(`${artefact.name}: ${target.path} (was ${state})`)
      console.log(`  updated   ${target.path}  ${state} -> ${canonical}`)
      if (artefact.name === 'maintenance') replacedSelf.push(target.path)
    } catch (error) {
      console.log(`  FAILED    ${target.path}  (${error.code ?? error.message})`)
      if (artefact.self) selfProblem(artefact, `was not replaced at ${target.path} (${error.code ?? error.message})`)
    }
  }
}

if (RETIRED_CODEX_SKILL.length && (!RUNTIMES || RUNTIMES.has('codex'))) {
  for (const old of RETIRED_CODEX_SKILL) {
    if (!existsSync(old) || !existsSync(CODEX_SKILL_HOME)) continue
    drifted += 1
    if (CHECK) {
      console.log(`  DRIFT     ${old}  (superseded by ${CODEX_SKILL_HOME}; Codex would list the skill twice)`)
      continue
    }
    rmSync(old, { force: true })
    repaired.push(`retired: ${old}`)
    console.log(`  retired   ${old}  (Codex reads ${CODEX_SKILL_HOME})`)
  }
  if (!CHECK) {
    try {
      rmdirSync(dirname(RETIRED_CODEX_SKILL[0]))
    } catch {}
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
    const stderr = execFileSync('cairn', ['note', NOTIFY_REF, note, '--kind', 'note', ...(NOTIFY_INSTANCE ? ['--instance', NOTIFY_INSTANCE] : [])], {
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

/**
 * Said last, in one place, so a run that could not update its own scripts is
 * not a quiet line in the middle of a long log. The exit status was set where
 * each problem was found.
 */
if (selfProblems.length > 0) {
  console.log('\nSELF-UPDATE FAILED: the maintenance scripts on this machine were not brought up to date.')
  for (const problem of selfProblems) console.log(`  ${problem}`)
  console.log('The copies on disk are unchanged and keep running; artefacts they do not know about are not installed.')
  console.log('Re-run `cairn setup` here to place them, or fix the cause above.')
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}

/**
 * The script that just ran was written before the release it syncs, so it
 * installed what it knew of and nothing else. Its replacement is the one that
 * knows the artefacts the release added, so it runs once more, from the same
 * resolved release — `--source <that tag>`, not another round of asking the
 * instances, which on a laptop off the VPN is a minute and a half of retries
 * for the one that does not answer.
 *
 * Only when the copy that ran is the copy that was replaced; a checkout run by
 * hand is not, and has nothing to learn. The flag stops the child from doing
 * this itself.
 */
const running = (() => {
  try {
    return realpathSync(process.argv[1])
  } catch {
    return null
  }
})()
const swapped = replacedSelf.some((path) => {
  try {
    return realpathSync(path) === running
  } catch {
    return false
  }
})
if (swapped && !CHECK && !REEXEC) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--source')
  if (at !== -1) args[at + 1] = SOURCE
  console.log(`\nre-running ${running} (updated) to install what this release added`)
  const child = spawnSync(process.execPath, [running, ...args], {
    stdio: 'inherit',
    env: { ...process.env, CAIRN_SYNC_REEXEC: '1' },
  })
  if (child.error || child.status === null) {
    console.log(`SELF-UPDATE FAILED: the updated script could not be run (${child.error?.code ?? child.signal ?? 'unknown'})`)
  }
  process.exit(child.status || process.exitCode || (child.error || child.status === null ? 1 : 0))
}
