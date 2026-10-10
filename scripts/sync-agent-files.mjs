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
 * reports (`--source release`), never from a branch that any push can move,
 * and it never replaces itself from the network. See `resolveSource` below.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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

const ARTEFACTS = [
  {
    name: 'skill',
    file: 'skills/cairn/SKILL.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/SKILL.md'), join(home, '.claude'), 'claude-code'),
      at(join(home, '.codex/skills/cairn/SKILL.md'), join(home, '.codex'), 'codex'),
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
      at(join(home, '.codex/skills/cairn/lab.md'), join(home, '.codex/skills/cairn'), 'codex'),
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
    // `self`: never replaced from a remote source — see REMOTE below.
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
  // tree) takes its lab.md along, with no second `--also` to remember.
  if (name === 'skill' && path && basename(path) === 'SKILL.md') {
    ARTEFACTS.find((a) => a.name === 'skill:lab').targets.push(at(join(dirname(path), 'lab.md')))
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

/**
 * The network is not trusted with the repairer itself.
 *
 * A script that rewrites its own code from a URL on a timer cannot be audited
 * once it is installed: whatever was reviewed is gone by the next slot. So from
 * a remote source the two maintenance scripts are never written — they change
 * when `cairn setup` runs, which places them from the release it installs, or
 * when the source is a tree on disk (a checkout, or the deploy's own tree),
 * which somebody put there on purpose.
 */
const REMOTE = /^https?:\/\//.test(SOURCE)
console.log(`source    ${SOURCE}`)

const readSource = async (file) => {
  if (!REMOTE) return readFileSync(join(SOURCE, file))
  const response = await fetchWithRetry(`${SOURCE.replace(/\/+$/, '')}/${file}`)
  if (!response.ok) throw new Error(`${file} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Every file is read before any is written. One that cannot be fetched — a tag
 * the mirror never got, a CDN hiccup halfway down the list — used to throw
 * after the files before it had been replaced, leaving a machine on two
 * releases at once. Now it is all of them or none.
 */
const sources = new Map()
for (const artefact of ARTEFACTS) {
  if (REMOTE && artefact.self) continue
  try {
    sources.set(artefact.name, await readSource(artefact.file))
  } catch (error) {
    refuse(`could not read ${artefact.file} from ${SOURCE} (${error.cause?.code ?? error.code ?? error.message})`)
  }
}

const repaired = []
let drifted = 0

for (const artefact of ARTEFACTS) {
  if (!sources.has(artefact.name)) {
    console.log(`\n${artefact.name}  ${artefact.file}`)
    console.log('  skipped   (updated by `cairn setup`, never from a remote source)')
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
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, source)
      chmodSync(target.path, artefact.mode)
      // Run as root, a file this creates in someone's home would be root's,
      // and that person's own installer could no longer replace it. A file
      // that existed keeps its owner; a new one takes its directory's.
      if (!present && process.getuid?.() === 0) {
        const { uid, gid } = statSync(dirname(target.path))
        chownSync(target.path, uid, gid)
      }
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

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}
