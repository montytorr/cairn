#!/usr/bin/env node
/**
 * cairn — the single implementation every agent calls.
 *
 * Deliberately dependency-free: Node 22's built-in fetch is enough, so the CLI
 * can be dropped onto a box and run without an install step. Claude Code,
 * Codex and OpenClaw all reach it the same way, through a shell.
 *
 * Output discipline is the point, not a detail. Lists are TSV with the keys
 * emitted once as a header, nulls omitted, a count-first line so the caller
 * can paginate before parsing, and — on search — an estimated token cost per
 * row so the model can decline to open something.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { homedir, hostname } from 'node:os'

const CAIRN_DIR = join(homedir(), '.cairn')

/**
 * Credentials come from the environment, falling back to ~/.cairn/env — so an
 * agent skill works without the user having to edit a shell profile first.
 * Format is plain KEY=value lines.
 */
const fileEnv = (path) => {
  try {
    if (!path || !existsSync(path)) return {}
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

/**
 * Kept in step with package.json by a test, because this file is copied to
 * machines rather than installed from a registry: it is the copy on the box
 * that matters, and nothing else would notice it going stale. A CLI three days
 * old was found writing under the wrong identity exactly once, which was
 * enough.
 */
const VERSION = '0.6.0'

/**
 * Which Cairn this command talks to, on a machine that uses more than one.
 *
 * One machine can hold a personal and a professional instance, and nothing in
 * a task ref, a project key or a directory name says which a command is for.
 * Guessing is how a client's notes end up on the personal server, so the
 * choice is explicit or it is not made: `--instance`, CAIRN_INSTANCE, or the
 * default ~/.cairn/instances.json names. With none of them, and the file set to
 * ask, the command stops before any request with exit 10, which tells an agent
 * to ask the user rather than try again.
 *
 * Every instance keeps its own state in ~/.cairn/instances/<name>/ — env,
 * outbox, ownership, projects.json — because a ref or a directory mapped on
 * one means nothing on the other. No instances.json is the single-instance
 * machine this CLI has always served, and nothing about it changes.
 */
const INSTANCES_PATH = join(CAIRN_DIR, 'instances.json')
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const UNDECIDED_EXIT = 10

const readInstances = () => {
  if (!existsSync(INSTANCES_PATH)) return null
  let config
  try {
    config = JSON.parse(readFileSync(INSTANCES_PATH, 'utf8'))
  } catch (error) {
    return { error: `~/.cairn/instances.json is not valid JSON (${error.message})` }
  }
  if (config?.version !== 1) return { error: '~/.cairn/instances.json: "version" must be 1' }
  const instances = config.instances
  if (!instances || typeof instances !== 'object' || Array.isArray(instances) || !Object.keys(instances).length) {
    return { error: '~/.cairn/instances.json: "instances" must name at least one instance' }
  }
  for (const [name, instance] of Object.entries(instances)) {
    if (!INSTANCE_NAME.test(name)) {
      return { error: `~/.cairn/instances.json: "${name}" is not an instance name (lowercase letters, digits and dashes)` }
    }
    let url
    try { url = new URL(instance?.url) } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      return { error: `~/.cairn/instances.json: instance "${name}" needs an http(s) "url"` }
    }
  }
  const unclassified = config.unclassified ?? { mode: 'ask' }
  if (unclassified.mode === 'default' ? !instances[unclassified.instance] : unclassified.mode !== 'ask') {
    return {
      error: '~/.cairn/instances.json: "unclassified" must be {"mode": "ask"} or ' +
        '{"mode": "default", "instance": <one of the instances>}',
    }
  }
  if (config.routes !== undefined && !Array.isArray(config.routes)) {
    return { error: '~/.cairn/instances.json: "routes" must be a list' }
  }
  // Compared canonically, so a hand-written /tmp/x matches the /private/tmp/x
  // a directory resolves to on macOS.
  const routes = (config.routes ?? []).map((r) => (typeof r?.path === 'string' && isAbsolute(r.path) ? { ...r, path: realDir(r.path) } : r))
  for (const route of routes) {
    const problem = routeProblem(route, instances, routes)
    if (problem) return { error: `~/.cairn/instances.json: ${problem}` }
  }
  return { instances, unclassified, routes, raw: config }
}

/**
 * A flag's value, read before the parser runs because the credentials below
 * depend on it, and read the way the parser reads it: the last one wins, and
 * a bare flag is '' rather than "not given".
 */
const earlyFlag = (name) => {
  const argv = process.argv.slice(2)
  let found
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith(`--${name}=`)) found = argv[i].slice(name.length + 3)
    else if (argv[i] === `--${name}`) found = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : ''
  }
  return found
}

/**
 * The words that are not flags or flag values, split the way the parser below
 * splits them. Routing has to know which word is the command and which is its
 * ref: `block --reason DONE-1 CAI-42` is about CAI-42, and the reason's text
 * must not decide where it goes.
 */
const earlyPositional = (() => {
  const argv = process.argv.slice(2)
  const words = []
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) words.push(argv[i])
    else if (!argv[i].includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1
  }
  return words
})()

/**
 * A bare `--instance` is an error rather than "none given": on a machine with
 * a default, the second reading would send a mistyped command to the default.
 */
const requestedInstance = () => {
  const flag = earlyFlag('instance')
  if (flag !== undefined) return flag ? { name: flag } : { error: '--instance needs the name of an instance' }
  const fromEnv = process.env.CAIRN_INSTANCE?.trim()
  return fromEnv ? { name: fromEnv } : {}
}

// ---------------------------------------------------------------------------
// routes: which instance a directory, a ref or a session belongs to
// ---------------------------------------------------------------------------
const HOME = homedir()
const SESSION_ROUTES_DIR = join(CAIRN_DIR, 'session-routes')
const UNROUTED_DIR = join(CAIRN_DIR, 'unrouted')
const SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/
const REF_ARG = /^([A-Z][A-Z0-9]{1,9})-\d+$/

/** For messages: a path under the home directory, without the username in it. */
const tilde = (path) => (path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path)

const realDir = (dir) => {
  try { return realpathSync(dir) } catch { return dir }
}

/**
 * What a directory is routed by: the main checkout of the repository it is in,
 * or the directory itself outside one.
 *
 * The main checkout rather than the worktree, because a worktree is the same
 * work in another folder and classifying every one of them by hand is how the
 * question gets asked forty times. GIT_DIR and friends are dropped: an
 * environment variable must not be able to say which repository this is.
 */
const routeKeys = new Map()
const routeKey = (dir) => {
  if (!routeKeys.has(dir)) routeKeys.set(dir, computeRouteKey(dir))
  return routeKeys.get(dir)
}
const computeRouteKey = (dir) => {
  const real = realDir(dir)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/.test(k)))
  try {
    const [top, common] = execFileSync(
      'git',
      ['-C', real, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000, env },
    ).trim().split('\n')
    return { key: realDir(basename(common) === '.git' ? dirname(common) : top), repo: true }
  } catch {
    return { key: real, repo: false }
  }
}

/**
 * An exact route names one repository or directory; a folder route covers
 * everything under it. Exact beats folder, and folders never nest, so there is
 * never a question of which of two rules won.
 */
const routeFor = (key, routes) =>
  routes.find((r) => r.match === 'exact' && r.path === key) ??
  routes.find((r) => r.match === 'folder' && (key === r.path || key.startsWith(`${r.path}/`))) ??
  null

/**
 * Why a route cannot be saved, or null. A folder route on the home directory
 * or the root would classify everything at once, which is the mistake this
 * whole mechanism exists to prevent; the default instance is the catch-all.
 */
const routeProblem = (route, instances, routes) => {
  if (!route || typeof route.path !== 'string' || !isAbsolute(route.path)) return 'a route needs an absolute "path"'
  if (!['exact', 'folder'].includes(route.match)) return `route ${tilde(route.path)}: "match" must be "exact" or "folder"`
  if (!instances[route.instance]) return `route ${tilde(route.path)}: no instance named "${route.instance}"`
  if (route.match === 'folder') {
    if (route.path === '/' || route.path === HOME) {
      return `a folder route on ${tilde(route.path)} would classify everything under it; use the default instance instead`
    }
    const clash = routes.find((r) => r !== route && r.match === 'folder' &&
      (r.path === route.path || r.path.startsWith(`${route.path}/`) || route.path.startsWith(`${r.path}/`)))
    if (clash) return `folder routes ${tilde(clash.path)} and ${tilde(route.path)} overlap; keep one`
  }
  if (route.match === 'exact' && routes.some((r) => r !== route && r.match === 'exact' && r.path === route.path)) {
    return `${tilde(route.path)} is routed twice`
  }
  return null
}

const instanceDir = (name) => join(CAIRN_DIR, 'instances', name)

/**
 * The project keys each instance was last seen to have, refreshed by that
 * instance's own requests. Read only here, so a ref names its instance without
 * a question and without asking a server that may not be the one it is for.
 */
const PROJECT_KEYS_FILE = 'project-keys.json'
const instancesWithKey = (key, instances) =>
  Object.keys(instances).filter((name) => {
    try {
      return JSON.parse(readFileSync(join(instanceDir(name), PROJECT_KEYS_FILE), 'utf8')).keys?.includes(key)
    } catch {
      return false
    }
  })

/** `session end --id` speaks for a session the hook is not running inside. */
const routeSession = () => {
  const argv = process.argv.slice(2)
  const raw = argv[0] === 'session' ? earlyFlag('id') : undefined
  const id = (raw || process.env.CAIRN_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || '').trim()
  return SESSION_ID.test(id) ? id : null
}

const sessionRoute = (session, instances) => {
  if (!session) return null
  try {
    const { instance } = JSON.parse(readFileSync(join(SESSION_ROUTES_DIR, `${session}.json`), 'utf8'))
    return instances[instance] ? instance : null
  } catch {
    return null
  }
}

/** Sessions parked by the session-end hook because nobody had said where they go. */
const parkedSessions = () => {
  try {
    return readdirSync(UNROUTED_DIR)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try { return [{ file: join(UNROUTED_DIR, f), ...JSON.parse(readFileSync(join(UNROUTED_DIR, f), 'utf8')) }] } catch { return [] }
      })
  } catch {
    return []
  }
}

/**
 * Where a directory's commands go, and why — or why nothing can be said.
 *
 * A saved route comes before a ref: it is an answer somebody gave on purpose,
 * and the ref's side is a cache of project keys that can be hours old. When
 * the two disagree the route still wins, and the caller is told how to send
 * the one command elsewhere rather than having it done for them.
 */
const resolveRoute = ({ config, dir, session, ref }) => {
  const { instances, unclassified, routes } = config
  const owners = ref ? instancesWithKey(ref, instances) : []
  const { key, repo } = routeKey(dir)
  const route = routeFor(key, routes)
  if (route) {
    const elsewhere = owners.length === 1 && owners[0] !== route.instance
    return {
      name: route.instance,
      why: `${route.match === 'folder' ? 'folder ' : ''}route ${tilde(route.path)}`,
      ...(elsewhere ? { hint: `cairn: ${ref} is a project on ${owners[0]}, and this directory is routed to ${route.instance}; add --instance ${owners[0]} if it is meant for ${owners[0]}` } : {}),
    }
  }
  if (owners.length === 1) return { name: owners[0], why: `${ref} is a project there` }
  const bySession = sessionRoute(session, instances)
  if (bySession) return { name: bySession, why: 'chosen for this session' }
  if (unclassified.mode === 'default') return { name: unclassified.instance, why: 'default instance' }
  return { name: null, key, repo }
}

const undecidedMessage = ({ key, repo }, instances, session) => {
  const here = repo ? 'this repository' : 'this directory'
  const waiting = parkedSessions().filter((p) => p.cwd && routeKey(p.cwd).key === key).length
  return [
    `cairn: this machine uses several Cairn instances (${Object.keys(instances).join(', ')}) and nothing says ` +
      `which one ${tilde(key)} is for. Ask the user which one, save the answer, then re-run the command:`,
    `  cairn route add <instance>             ${here}`,
    ...(key !== HOME && key !== '/' ? [`  cairn route add <instance> --folder    ${tilde(key)} and everything under it`] : []),
    ...(session ? ['  cairn route add <instance> --session   this session only'] : []),
    '  (--instance <name> on a command uses that instance for it alone)',
    ...(waiting ? [`${waiting} earlier session(s) here are waiting for the answer and are sent when it is saved.`] : []),
  ].join('\n')
}

const writeInstancesConfig = (config) => {
  mkdirSync(CAIRN_DIR, { recursive: true })
  const temp = `${INSTANCES_PATH}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, INSTANCES_PATH)
}

/**
 * Save an answer. Returns the problem as a string instead of dying, because
 * the terminal prompt below has to be able to say it and ask again.
 */
const saveRoute = (config, { instance, key, folder, session, force }) => {
  if (!config.instances[instance]) return `no instance named "${instance}" (it has: ${Object.keys(config.instances).join(', ')})`
  if (session) {
    mkdirSync(SESSION_ROUTES_DIR, { recursive: true, mode: 0o700 })
    // A week is longer than any session; the files are one line each.
    for (const f of readdirSync(SESSION_ROUTES_DIR)) {
      try { if (Date.now() - statSync(join(SESSION_ROUTES_DIR, f)).mtimeMs > 7 * 86_400_000) unlinkSync(join(SESSION_ROUTES_DIR, f)) } catch { /* raced */ }
    }
    writeFileSync(join(SESSION_ROUTES_DIR, `${session}.json`), `${JSON.stringify({ instance, t: new Date().toISOString() })}\n`, { mode: 0o600 })
    return null
  }
  const match = folder ? 'folder' : 'exact'
  const existing = config.routes.find((r) => r.match === match && r.path === key)
  if (existing && existing.instance !== instance && !force) {
    return `${tilde(key)} is already routed to ${existing.instance}; re-run with --force to change it on purpose`
  }
  const route = { path: key, match, instance }
  const routes = [...config.routes.filter((r) => r !== existing), route]
  const problem = routeProblem(route, config.instances, routes)
  if (problem) return problem
  writeInstancesConfig({ ...(config.raw ?? {}), ...config, raw: undefined, version: 1, routes })
  return null
}

/** Ask a person at a terminal, once, instead of printing instructions meant for an agent. */
const askInTerminal = async (config, undecided, session) => {
  const names = Object.keys(config.instances)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    process.stderr.write(`cairn: which Cairn instance is ${tilde(undecided.key)} for?\n`)
    names.forEach((n, i) => process.stderr.write(`  ${i + 1}. ${n}  ${config.instances[n].url}\n`))
    const picked = names[Number((await rl.question('instance number: ')).trim()) - 1]
    if (!picked) return null
    const scopes = [
      ['this one command', null],
      [undecided.repo ? 'this repository' : 'this directory', { key: undecided.key }],
      ...(undecided.key !== HOME && undecided.key !== '/' ? [[`${tilde(undecided.key)} and everything under it`, { key: undecided.key, folder: true }]] : []),
      ...(session ? [['this session only', { session }]] : []),
    ]
    scopes.forEach(([label], i) => process.stderr.write(`  ${i + 1}. ${label}\n`))
    const scope = scopes[Number((await rl.question(`remember it for [2]: `)).trim() || '2') - 1]
    if (!scope) return null
    if (scope[1]) {
      const problem = saveRoute(config, { instance: picked, ...scope[1] })
      if (problem) {
        process.stderr.write(`cairn: ${problem}\n`)
        return null
      }
    }
    return picked
  } finally {
    rl.close()
  }
}

const INSTANCES = readInstances()
/**
 * The directory a command is about: `--cwd` when a hook speaks for a session
 * that ran somewhere else, this process's own directory otherwise.
 */
const ROUTE_DIR = earlyFlag('cwd') || process.cwd()
const ROUTE_SESSION = routeSession()
// Commands that only look at local configuration never need an instance, and
// must not stop to ask for one.
const LOCAL_ONLY = new Set(['route', 'instance', 'help'])
const EARLY_COMMAND = earlyPositional[0]
const JUST_HELP = (!EARLY_COMMAND && !process.argv.includes('--version')) || EARLY_COMMAND === 'help' || process.argv.includes('--help')
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !LOCAL_ONLY.has(EARLY_COMMAND) &&
  !JUST_HELP && !process.argv.includes('--version') && EARLY_COMMAND !== 'version'

const selectInstance = async () => {
  const { name: requested, error } = requestedInstance()
  if (error) return { error }
  if (!INSTANCES) {
    return requested
      ? { error: `--instance ${requested}: this machine has no ~/.cairn/instances.json, so it has one instance` }
      : { name: null, dir: CAIRN_DIR }
  }
  if (INSTANCES.error) return { error: INSTANCES.error }
  const { instances } = INSTANCES
  const at = (name, why) => ({ name, why, dir: instanceDir(name), url: instances[name].url.replace(/\/+$/, '') })
  if (requested) {
    return instances[requested]
      ? at(requested, 'asked for')
      : { error: `no instance named "${requested}" in ~/.cairn/instances.json (it has: ${Object.keys(instances).join(', ')})` }
  }
  // Help reads nothing and sends nothing; it should not wait on git to say so.
  if (JUST_HELP) return { undecided: 'cairn: no instance chosen' }
  const ref = REF_ARG.exec(earlyPositional[1] ?? '')?.[1]
  const route = resolveRoute({ config: INSTANCES, dir: ROUTE_DIR, session: ROUTE_SESSION, ref })
  if (route.hint) process.stderr.write(`${route.hint}\n`)
  if (route.name) return at(route.name, route.why)
  if (INTERACTIVE) {
    const picked = await askInTerminal(INSTANCES, route, ROUTE_SESSION)
    if (picked) return at(picked, 'chosen at the terminal')
  }
  return { undecided: undecidedMessage(route, instances, ROUTE_SESSION), route }
}

const INSTANCE = await selectInstance()

/** Where this instance's files live, for messages: never a path with a username in it. */
const STATE_LABEL = INSTANCE.name ? `~/.cairn/instances/${INSTANCE.name}` : '~/.cairn'
const ENV_LABEL = `${STATE_LABEL}/env`
const STATE_DIR = INSTANCE.dir ?? CAIRN_DIR

const FILE_ENV = fileEnv(INSTANCE.dir && join(INSTANCE.dir, 'env'))
/**
 * Which session is running this command.
 *
 * The API key names a runtime and a human -- `claude-code · cal@example.com`
 * -- and every Claude Code session on a machine sends the same one. That is an
 * identity, not a worker, and the difference cost a duplicated implementation
 * the day this was written: two sessions picked up the same task because
 * neither could see who held it.
 *
 * Claude Code puts the session id in the environment of every command it runs,
 * and it is the same id as the transcript's, so this costs nothing to obtain.
 * CAIRN_SESSION_ID is the override for a runtime that knows better, and no
 * session at all is a perfectly normal answer -- the server treats an absent
 * session exactly as it behaved before any of this existed.
 */
const SESSION = (() => {
  const raw = (process.env.CAIRN_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  return raw && raw.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : null
})()

/**
 * A read that is part of a sweep, not a recall (CAIRN-289).
 *
 * 1,169 of 1,243 knowledge reads were audit loops fetching 10-141 slugs a
 * minute, and every one marked its entry as recalled — so `know --unused`
 * could not find the facts nobody uses. The server also tags bursts by rate;
 * this is the explicit form, for a script that knows it is sweeping:
 * `CAIRN_SWEEP=1 cairn know <slug>` or `--sweep`.
 */
// Read through `flags` when a request is made, so the flag counts as used by
// whichever verb it was passed to rather than being reported as ignored.
const sweeping = () => process.env.CAIRN_SWEEP === '1' || Boolean(flags.sweep)

/**
 * Which machine is speaking.
 *
 * A key names a runtime and a human, and the same key names go onto every
 * machine that human uses — so `claude-code · cal@…` on a laptop and on a
 * server are one actor string, and a misattributed note cannot be traced back
 * to the box that wrote it (CAIRN-290). The actor string is deliberately left
 * alone: it is the join key for the whole history. The host travels beside it
 * and the server records it where a row already has room for it. An older
 * server ignores the header.
 */
const HOST = (() => {
  let raw = process.env.CAIRN_HOST
  if (raw === undefined) {
    try { raw = hostname() } catch { raw = '' }
  }
  raw = String(raw ?? '').trim()
  return raw && raw.length <= 100 && /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null
})()

/** Every request carries it, so no endpoint needs a parameter for it. */
const authHeaders = (extra = {}) => ({
  Authorization: `Bearer ${KEY}`,
  ...(SESSION ? { 'X-Cairn-Session': SESSION } : {}),
  ...(sweeping() ? { 'X-Cairn-Read': 'sweep' } : {}),
  ...(HOST ? { 'X-Cairn-Host': HOST } : {}),
  ...extra,
})

const trimUrl = (url) => (url ?? '').replace(/\/+$/, '')

const BASE = INSTANCE.url ??
  (INSTANCES ? '' : trimUrl(process.env.CAIRN_BASE_URL || FILE_ENV.CAIRN_BASE_URL || 'http://localhost:3000'))

/**
 * With several instances, a URL or key from anywhere but the chosen instance
 * is refused rather than preferred. The environment wins on a one-instance
 * machine because it is how a command borrows an identity; here it would be
 * how a command silently writes to the wrong server, and a key in the
 * environment does not say which instance it was issued by.
 */
const INSTANCE_REFUSAL = (() => {
  if (INSTANCE.error) return { message: `cairn: ${INSTANCE.error}`, code: 2 }
  if (INSTANCE.undecided) return { message: INSTANCE.undecided, code: UNDECIDED_EXIT }
  if (!INSTANCE.name) return null
  for (const [where, url] of [['CAIRN_BASE_URL', process.env.CAIRN_BASE_URL], [`CAIRN_BASE_URL in ${ENV_LABEL}`, FILE_ENV.CAIRN_BASE_URL]]) {
    if (url && trimUrl(url) !== BASE) {
      return {
        message: `cairn: ${where} points at a different server than instance "${INSTANCE.name}" ` +
          `(~/.cairn/instances.json). Remove it; the instance decides the server.`,
        code: 2,
      }
    }
  }
  if (process.env.CAIRN_API_KEY) {
    return {
      message: `cairn: CAIRN_API_KEY is set in the environment, and on a machine with several instances ` +
        `it cannot say which one issued it. Put the key in ${ENV_LABEL} instead.`,
      code: 2,
    }
  }
  return null
})()

/**
 * Which runtime is speaking.
 *
 * The API key IS the identity -- an actor_id comes from the key, not from
 * anything the caller says -- and one key per machine meant every runtime on
 * a host wrote as whoever owned that file — so on one machine every Codex
 * task, claim and close was filed under OpenClaw's name, and no agent could be
 * held to its own behaviour.
 *
 * Per-user key files cannot fix it either: Codex may run as more than one
 * user on the same box, and share a user with OpenClaw.
 *
 * So the runtime names itself, and the file can carry a key per runtime.
 * `CLAUDECODE` is set by Claude Code itself; the others are set where the
 * runtime is launched, which is the only place that knows.
 */
/**
 * Codex's own markers. CODEX_THREAD_ID is exported into every shell Codex
 * runs; the CODEX_MANAGED_* pair comes from its npm launcher.
 */
const hasCodexMarker = (env) =>
  Boolean(
    env.CODEX_THREAD_ID ||
      env.CODEX_SANDBOX ||
      env.CODEX_MANAGED_BY_NPM ||
      env.CODEX_MANAGED_PACKAGE_ROOT,
  )

/** What a process's command line says it is, from its first two words. */
const runtimeOfCommand = (command) => {
  const words = String(command ?? '').trim().split(/\s+/).slice(0, 2).map((w) => basename(w))
  if (words.some((w) => w === 'codex' || w === 'codex.js')) return 'codex'
  if (words.some((w) => w === 'claude') || /@anthropic-ai\/claude-code\//.test(command)) return 'claude-code'
  return null
}

/**
 * The nearest ancestor that is a runtime, walking up from this process.
 *
 * Environment variables are inherited, so they say every runtime this process
 * is nested inside and not which one is innermost: a Codex started from a
 * Claude Code shell carries CLAUDECODE=1 into every command it runs, and all
 * of its writes were filed as claude-code (CAIRN-290). The process tree is
 * the one thing that records nesting. Only consulted when the environment is
 * ambiguous, so the ordinary call pays for no `ps` at all.
 */
const innermostRuntime = () => {
  let pid = process.ppid
  for (let hop = 0; hop < 20 && pid > 1; hop += 1) {
    let line
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim()
    } catch {
      return null
    }
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) return null
    const found = runtimeOfCommand(match[2])
    if (found) return found
    pid = Number(match[1])
  }
  return null
}

const detectAgent = () => {
  if (process.env.CAIRN_AGENT) return process.env.CAIRN_AGENT.trim().toLowerCase()
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
    // Both sets of markers: nested one way or the other. Ask the process tree,
    // and keep the old answer when it cannot say.
    if (hasCodexMarker(process.env) && innermostRuntime() === 'codex') return 'codex'
    return 'claude-code'
  }

  // OpenClaw runs Codex underneath, pointed at a CODEX_HOME of its own
  // (an `.openclaw/.../codex-home` of its own). Testing for
  // Codex first would therefore file every one of OpenClaw's writes as Codex
  // -- the same misattribution this exists to fix, pointing the other way.
  const codexHome = process.env.CODEX_HOME ?? ''
  if (/openclaw/i.test(codexHome)) return 'openclaw'

  // Any OPENCLAW_* variable at all, rather than two guessed names.
  //
  // The live gateway sets OPENCLAW_SERVICE_MARKER, OPENCLAW_SYSTEMD_UNIT and
  // eight more, and none of them is OPENCLAW_SESSION or OPENCLAW_HOME — the two
  // that were checked here. The whole of OpenClaw's identity therefore rested
  // on its CODEX_HOME containing the word, and if that ever stopped being true
  // it would now fall through to the Codex markers below, which OpenClaw also
  // sets, and file every one of its writes as Codex.
  if (Object.keys(process.env).some((name) => name.startsWith('OPENCLAW_'))) return 'openclaw'

  // CODEX_MANAGED_* are set by Codex itself, and are the only markers that
  // survive being launched directly.
  //
  // Detection used to rest on CODEX_HOME, which Codex reads but does not
  // export, so /usr/local/bin/codex was installed to set it. A live session was
  // found running as `node /usr/bin/codex --yolo` with no CODEX_HOME at all —
  // the wrapper bypassed — so detection returned nothing and the CLI fell back
  // to the machine's default key, which on that host is OpenClaw's. Every
  // Codex write was filed as OpenClaw, exactly as before the wrapper existed.
  //
  // These are checked after the OpenClaw tests on purpose: OpenClaw runs Codex
  // underneath and therefore sets them too.
  if (codexHome || hasCodexMarker(process.env)) return 'codex'
  return ''
}

const AGENT = detectAgent()

/**
 * An explicit CAIRN_API_KEY in the environment always wins -- it is how a
 * one-off command borrows another identity. Otherwise the runtime's own key is
 * preferred, and the plain one is the fallback, so a machine that has not been
 * split yet keeps working exactly as before.
 */
const keyNameFor = (agent) => `CAIRN_API_KEY_${agent.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

const OWN_KEY = AGENT ? FILE_ENV[keyNameFor(AGENT)] : undefined

const KEY = process.env.CAIRN_API_KEY || OWN_KEY || FILE_ENV.CAIRN_API_KEY || ''

/**
 * Borrowing another runtime's identity should be a decision, not an accident.
 *
 * On a machine that has been split into per-agent keys, falling back to the
 * plain one files the work under whichever agent that key belongs to. It did
 * exactly that for weeks: Codex could not be detected, so every write it made
 * was attributed to OpenClaw, and nothing anywhere said so — the statistics
 * looked fine, they were just about the wrong agent.
 *
 * A warning rather than a refusal, because the fallback is legitimate on a
 * machine that has not been split, and refusing would break it.
 */
const SPLIT_KEYS = Object.keys(FILE_ENV).filter((name) => name.startsWith('CAIRN_API_KEY_'))
const BORROWING =
  !process.env.CAIRN_API_KEY && !OWN_KEY && SPLIT_KEYS.length > 0 && Boolean(FILE_ENV.CAIRN_API_KEY)

/**
 * Identities that must never borrow, because nobody reads their warnings.
 *
 * `maintenance` runs from a schedule, with its output in a log file or thrown
 * away. On a machine with no CAIRN_API_KEY_MAINTENANCE it fell back to the
 * plain key, which on that machine was Claude Code's, and 27 scheduled repair
 * notes on CAIRN-107 were filed as claude-code; the warning went to
 * `stdio: 'ignore'` (CAIRN-290). An interactive runtime keeps the warning,
 * because refusing would drop a real session's work; a scheduled job loses
 * nothing by failing loudly and being fixed.
 */
const MUST_NOT_BORROW = new Set(['maintenance'])
const IDENTITY_REFUSAL =
  BORROWING && MUST_NOT_BORROW.has(AGENT)
    ? `cairn: CAIRN_AGENT=${AGENT} has no ${keyNameFor(AGENT)} in ${ENV_LABEL}, and this identity ` +
      `refuses to fall back to the default key, which belongs to another runtime. ` +
      `Add ${keyNameFor(AGENT)}=<a key named ${AGENT}> to ${ENV_LABEL}.`
    : null

/** Every path that would send the key goes through this first. */
const requireKey = () => {
  if (INSTANCE_REFUSAL) {
    process.stderr.write(`${INSTANCE_REFUSAL.message}\n`)
    process.exit(INSTANCE_REFUSAL.code)
  }
  if (IDENTITY_REFUSAL) {
    process.stderr.write(`${IDENTITY_REFUSAL}\n`)
    process.exit(3)
  }
  if (!KEY) {
    process.stderr.write(`CAIRN_API_KEY is not set (${INSTANCE.name ? ENV_LABEL : `env, or ${ENV_LABEL}`}).\n`)
    process.exit(1)
  }
}

if (BORROWING && !IDENTITY_REFUSAL) {
  process.stderr.write(
    `cairn: could not tell which runtime this is${AGENT ? ` (${AGENT} has no ${keyNameFor(AGENT)})` : ''}, ` +
      `so this write will be filed under the default key. ` +
      `Set CAIRN_AGENT, or add ${AGENT ? keyNameFor(AGENT) : 'CAIRN_API_KEY_<AGENT>'} to ${ENV_LABEL}.\n`,
  )
}

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const positional = []

/**
 * What the caller typed, and what the command actually looked at.
 *
 * KNOWN_FLAGS below catches a flag NOTHING in this file reads. It cannot catch
 * a flag one verb reads and another does not, because it is one list for every
 * verb — and that is a real failure, not a theoretical one: `cairn relearn
 * <slug> --global` parsed, printed the updated entry, exited 0, and left the
 * scope exactly as it was, three lines below the comment explaining why a
 * silently dropped flag is unacceptable (CAIRN-262).
 *
 * The obvious fix is a table of which flags each verb takes. This is not that,
 * because the argument against a table is right — it rots the first time a
 * verb grows an option, and a wrong entry makes a legitimate command start
 * exiting 2 on every machine at once, which is a worse failure than the one it
 * prevents.
 *
 * So the reads ARE the registry. `flags` is a proxy that records every key
 * looked at while the command runs; afterwards, anything the caller passed and
 * nobody read is reported. Nothing to enumerate, nothing to keep in step, and
 * it is exact rather than approximate — it reports what this invocation did,
 * not what some static analysis believes the code would do.
 */
const typedFlags = {}
const readFlags = new Set()
const flags = new Proxy(typedFlags, {
  get(target, key) {
    if (typeof key === 'string') readFlags.add(key)
    return target[key]
  },
  has(target, key) {
    if (typeof key === 'string') readFlags.add(key)
    return key in target
  },
})

/**
 * Every flag this CLI reads, anywhere.
 *
 * The parser used to accept whatever it was given, so `cairn know --banana
 * split` returned results and exited 0, and `--offset 3` — which nothing
 * implements — returned page one forever with no way to discover it. An agent
 * paginating that way cannot tell success from silence, and this CLI's entire
 * audience is agents.
 *
 * The list is global rather than per-command on purpose: it catches the typo
 * and the flag that does not exist, which is the whole failure here, without
 * needing a table per verb that would rot the first time one grows an option.
 *
 * "A real flag passed to a verb that ignores it still passes here — worth
 * knowing, but a smaller problem than a silent wrong answer" is what this
 * comment used to say next, and it was wrong. `relearn --global` was exactly
 * that case, and it WAS a silent wrong answer: the scope did not change and
 * the command printed the entry and exited 0 (CAIRN-262). The per-verb half
 * is handled above, by the proxy on `flags` — not by a table, because the
 * objection to a table still stands.
 *
 * BUILT BY HAND AND GUARDED BY A TEST, because the first version was built by
 * grepping `flags.X` and missed every flag read dynamically — `flags[k]` over
 * ['type','status','priority'], and the [flag, field] pairs in `run` and
 * `session end`. That shipped, and `cairn add --priority high` — documented in
 * this file's own help — started failing. A whitelist is only as good as its
 * enumeration, so cli-flags.test.ts now asserts that every `--flag` named in
 * the help text is in this set. Add to both, or the test says so.
 */
const KNOWN_FLAGS = new Set([
  'adopt', 'agent', 'all', 'allow-dangling', 'also-project', 'archived', 'body',
  'branch', 'completed',
  'confirm', 'cwd', 'dangling', 'default', 'days', 'description', 'dir', 'dry-run',
  'duplicate-of', 'duration-ms', 'entity', 'exit-code', 'file', 'files', 'folder',
  'force', 'force-empty', 'full', 'gaps', 'global', 'help', 'history', 'hours', 'id', 'instance',
  'json', 'key', 'kind', 'kinds', 'label', 'learned', 'limit', 'max-parents',
  'message', 'mine', 'next', 'no-checkpoint', 'no-parent', 'no-start', 'notify', 'older',
  'orphans', 'output', 'parent', 'platform', 'pretty', 'priority', 'project',
  'reason', 'remote', 'repo', 'request', 'resolution', 'scheduled', 'scope',
  'session', 'show-toplevel', 'slug', 'start', 'started', 'status', 'summary',
  'superseded', 'superseded-by', 'sweep', 'task', 'tasks', 'title', 'tool-calls',
  'type', 'unused', 'url', 'verified', 'version',
])

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const [name, inline] = arg.slice(2).split('=')
    if (!KNOWN_FLAGS.has(name)) {
      const near = [...KNOWN_FLAGS]
        .filter((known) => known.startsWith(name.slice(0, 3)) || name.startsWith(known.slice(0, 3)))
        .slice(0, 3)
      process.stderr.write(
        `unknown flag --${name}\n` +
          (near.length ? `did you mean ${near.map((n) => `--${n}`).join(', ')}?\n` : '') +
          `this is refused rather than ignored: a flag that is silently dropped ` +
          `returns an answer that looks filtered and is not.\n`,
      )
      process.exit(2)
    }
    if (inline !== undefined) flags[name] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i]
    else flags[name] = true
  } else positional.push(arg)
}

const FORMAT = flags.json ? 'json' : flags.pretty ? 'pretty' : 'tsv'
// Already acted on, before parsing: they chose the instance above. --cwd is
// how any command says which directory it is about, not only context's.
void flags.instance
if (INSTANCES) void flags.cwd

/**
 * What this file actually is, as a 16-hex sha256 — the same digest
 * scripts/sync-agent-files.mjs prints, so the installer's log line and the
 * server's header are the same string for the same file.
 *
 * This is the only identifier a copied CLI can compute about itself. There is
 * no repository behind ~/.local/bin/cairn and no commit recorded in it; there
 * is a file, and a file can be read. Computed at most once per process and
 * only when a server has offered something to compare against — measured at
 * 0.049 ms for the 100KB this file weighs, which is well under the cost of
 * the request that triggered it, but there is no reason to pay it twice.
 */
let ownHash
const fingerprint = () => {
  if (ownHash !== undefined) return ownHash
  try {
    const path = process.argv[1] && existsSync(process.argv[1]) ? process.argv[1] : null
    ownHash = path
      ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
      : null
  } catch {
    // Unreadable — running from a bundle, a pipe, or somewhere with no read
    // permission on itself. Nothing to compare, so nothing is said.
    ownHash = null
  }
  return ownHash
}

/**
 * Every API response says which release served it and which CLI it shipped.
 * Compare once, so a stale copy says so on the ordinary path.
 *
 * `cairn --version` has always been able to answer this, but it is the one
 * command an agent has no reason to run: a drifted CLI goes on working, just
 * not the way the docs say. The Mac's copy was found only because `cairn
 * vitals` happened to come back "unknown command", after a day of writes under
 * the wrong identity.
 *
 * WHY TWO COMPARISONS. The version alone almost never fires. Releases are cut
 * by hand and 133 commits fitted inside v0.5.1, so a copy months of work
 * behind still agrees on the number — which is exactly the state the Mac was
 * in when this was written, both sides saying 0.5.1 while `--allow-dangling`
 * and the vitals memory block were missing (CAIRN-261). The version is still
 * the better thing to say when the two belong to different releases, because
 * it is what a human reads and what the docs are written against; the hash
 * catches everything finer, which is nearly everything.
 *
 * Silence when the server offers neither. A check that cannot run must leave
 * the CLI working, not warn on a guess.
 *
 * stderr, never stdout — callers parse stdout, and a warning in it is a bug.
 * Once per process, because the point is to be noticed, and a line repeated on
 * every request is a line nobody reads.
 */
/**
 * Which side of a drift is newer, when anything can say.
 *
 * The warning used to tell everybody to run the sync, and on the server the
 * sync is what had put the newer file there: it pulls `main` on its own clock,
 * so for a few minutes after a merge the CLI is AHEAD of the deploy, and the
 * advice was to fetch the file that was already installed (CAIRN-290).
 *
 * Two orderings are available. Releases compare as numbers. Within a release
 * the server may say when it was built (`x-cairn-built-at`), and this file's
 * mtime is when it was installed: a CLI written before the image it disagrees
 * with was built is the older side, and one written after it is almost always
 * a merge the deploy has not caught up with. Neither -> say so neutrally.
 */
const compareReleases = (a, b) => {
  const parse = (v) => String(v).split('.').map((part) => Number.parseInt(part, 10))
  const [x, y] = [parse(a), parse(b)]
  if ([...x, ...y].some(Number.isNaN)) return null
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  }
  return 0
}

const installedAt = () => {
  try {
    return process.argv[1] ? statSync(process.argv[1]).mtimeMs : null
  } catch {
    return null
  }
}

/**
 * The exact command that brings this machine's copy up to date, chosen by what
 * is installed here rather than by a guess about which host this is.
 */
const updateCommand = () => {
  const home = homedir()
  const agent = join(home, 'Library/LaunchAgents/com.cairn.agent-files.plist')
  if (process.platform === 'darwin' && existsSync(agent)) {
    return `launchctl kickstart gui/${process.getuid()}/com.cairn.agent-files`
  }
  const own = join(home, '.cairn/maintenance/install-cron.mjs')
  if (existsSync(own)) return `node ${own} --run agent-files`
  // The server's job lives in root's crontab, which is the one --run reads.
  const shared = '/opt/cairn-maintenance/install-cron.mjs'
  if (existsSync(shared)) {
    return `${process.getuid?.() === 0 ? '' : 'sudo '}node ${shared} --run agent-files`
  }
  const sync = join(home, '.cairn/maintenance/sync-agent-files.mjs')
  if (existsSync(sync)) {
    return `node ${sync} --source https://raw.githubusercontent.com/montytorr/cairn/main`
  }
  return `copy cli/cairn.mjs from the deployed commit over ${process.argv[1] ?? 'this file'}`
}

/** One line, or null when the two agree or the server offers nothing to compare. */
const driftLine = (headers) => {
  const version = headers?.get?.('x-cairn-version')
  const servedHash = headers?.get?.('x-cairn-cli')
  const builtAt = Date.parse(headers?.get?.('x-cairn-built-at') ?? '')

  let detail = null
  let order = null
  if (version && version !== VERSION) {
    detail = `this CLI is ${VERSION}, ${BASE} is ${version}`
    order = compareReleases(VERSION, version)
  } else if (servedHash) {
    const mine = fingerprint()
    // Same release, different file: the case the version can never see.
    if (mine && mine !== servedHash) {
      detail = `this CLI is ${VERSION} ${mine}, ${BASE} ships ${VERSION} ${servedHash}`
      const at = installedAt()
      if (at !== null && Number.isFinite(builtAt)) order = at < builtAt ? -1 : 1
    }
  }
  if (!detail) return null

  if (order === -1) return `cairn: this CLI is older than the server (${detail}) — update: ${updateCommand()}`
  if (order === 1) {
    return (
      `cairn: this CLI is newer than the server (${detail}) — probably a merge not deployed yet; ` +
      `nothing to do unless it persists`
    )
  }
  return `cairn: CLI and server differ (${detail}) — if the server is newer, update: ${updateCommand()}`
}

let warnedStale = false
const warnIfStale = (res) => {
  if (warnedStale) return
  const line = driftLine(res?.headers)
  if (!line) return
  warnedStale = true
  process.stderr.write(`${line}\n`)
}

/**
 * A rename, said out loud (CAIRN-264).
 *
 * AC was renamed HOL. Every old ref and `--project AC` went on resolving, and
 * nothing said why the answer came back as HOL — so an agent whose notes said
 * AC-113 could not tell it had the same task, and one filtering on AC could not
 * tell a renamed project from an empty one. The server now reports how it got
 * there (`requested_ref`, `renamed_from`); this says so.
 *
 * stderr, like every other advisory here: stdout is parsed, and the same facts
 * are in it already as fields for anything that parses. Once per key per
 * process, because a batch touching forty old refs needs telling once.
 */
const renameDay = (at) => (typeof at === 'string' ? at.slice(0, 10) : '?')

const renameLine = (requested, rename, ref) => {
  const by = rename.by ? ` by ${rename.by}` : ''
  if (requested && ref && requested !== ref) {
    return `${requested} is now ${ref} — project ${rename.key} was renamed ${rename.to} on ${renameDay(rename.at)}${by}. ${requested} still resolves; write ${ref}.`
  }
  return `note: project ${rename.key} is now ${rename.to} — renamed on ${renameDay(rename.at)}${by}. ${rename.key} still resolves; write ${rename.to}.`
}

const toldRenames = new Set()
const tellRename = (requested, rename, ref) => {
  if (!rename?.key || !rename?.to) return
  const id = `${requested ?? ''}|${rename.key}`
  if (toldRenames.has(id)) return
  toldRenames.add(id)
  process.stderr.write(`${renameLine(requested, rename, ref)}\n`)
}

/** `-` means read the value from stdin, so long markdown bodies stay off argv. */
const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
const resolveValue = async (v) => (v === '-' ? (await readStdin()).trim() : v)

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
/**
 * Gateway errors are transient and worth waiting out.
 *
 * A deploy takes the app down for a few seconds, and during that window every
 * call returns 502 from the proxy. That is survivable for a human retrying by
 * hand and fatal for a batch import or a session-end hook, which gets one
 * chance to record what happened before the session is gone.
 */
const TRANSIENT = new Set([502, 503, 504])
const RETRIES = 3

/**
 * How long a write may spend being retried before it is put aside instead.
 *
 * Writes normally return in about half a second. During a deploy the container
 * is down and they block for minutes — several `cairn add` calls ran past 120s
 * and 300s, every one of them while a container was restarting. Retrying is
 * right; making an agent mid-task wait for a restart is not. Cairn is supposed
 * to be the thing an agent can always write to.
 */
const DEADLINE_MS = Number(process.env.CAIRN_DEADLINE_MS ?? 15_000)

/** Guards against a replay triggering its own replay. */
let FLUSHING = false

/**
 * The outbox, and what is allowed into it.
 *
 * Only writes whose answer the caller does not need: a note, a comment, a
 * heartbeat, a checkpoint. `add` and `claim` are deliberately excluded — an
 * agent that is handed a ref which does not exist yet, or told it holds a task
 * it may not have won, is worse off than one told plainly that the write
 * failed. Those fail fast instead.
 */
const OUTBOX_PATH = join(STATE_DIR, 'outbox.jsonl')
const REJECTED_OUTBOX_PATH = `${OUTBOX_PATH}.rejected`
const OUTBOX_LOCK_PATH = `${OUTBOX_PATH}.lock`
const OUTBOX_PREFIX = 'outbox.jsonl.'
const QUEUEABLE = /\/(notes|comments|beat|checkpoint)$/
const KEY_ID = KEY ? createHash('sha256').update(KEY).digest('hex').slice(0, 24) : ''
const TEST_CRASH_AFTER_SEND = process.env.CAIRN_TEST_CRASH_AFTER_SEND === '1'
const TEST_FAIL_PERSIST_AFTER_SEND = process.env.CAIRN_TEST_FAIL_PERSIST_AFTER_SEND === '1'
const TEST_CRASH_AFTER_RENAME_BEFORE_STATE = process.env.CAIRN_TEST_CRASH_AFTER_RENAME_BEFORE_STATE === '1'
const TEST_FAIL_REJECT_PERSIST = process.env.CAIRN_TEST_FAIL_REJECT_PERSIST === '1'
const TEST_ENQUEUE_DURING_REPLAY = process.env.CAIRN_TEST_ENQUEUE_DURING_REPLAY ?? ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Put a write aside so the agent can carry on, and say so plainly. */
const withOutboxLock = async (run) => {
  mkdirSync(dirname(OUTBOX_PATH), { recursive: true })
  const deadline = Date.now() + Math.max(DEADLINE_MS, 5_000)
  let handle
  while (handle === undefined) {
    try {
      handle = openSync(OUTBOX_LOCK_PATH, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(OUTBOX_LOCK_PATH).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)) {
          unlinkSync(OUTBOX_LOCK_PATH)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for the outbox lock')
      await sleep(20)
    }
  }
  try {
    return await run()
  } finally {
    closeSync(handle)
    try { unlinkSync(OUTBOX_LOCK_PATH) } catch { /* stale recovery may already have removed it */ }
  }
}

const enqueue = async (method, path, body, why) => {
  try {
    await withOutboxLock(() => {
      if (path.split('?')[0].endsWith('/checkpoint')) {
        const state = rememberedTaskState(path)
        if (state) body = {
          ...body,
          ownershipVersion: state.ownershipVersion,
          checkpointVersion: state.checkpointVersion + pendingCheckpointCount(path, state.ownershipVersion),
        }
      }
      const item = {
        id: randomUUID(),
        t: new Date().toISOString(),
        method,
        path,
        body,
        agent: AGENT,
        base: BASE,
        keyId: KEY_ID,
      }
      appendFileSync(OUTBOX_PATH, `${JSON.stringify(item)}\n`, { mode: 0o600 })
    })
  } catch (error) {
    die(`${why}, and it could not be queued either: ${error.message}`)
  }
  process.stderr.write(`${why} — queued locally, replays on the next successful write\n`)
  return { queued: true, path }
}

const FOREIGN_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Whose queued write this is, decided before anything is sent.
 *
 * One outbox serves every runtime on the machine, so a write Claude Code
 * queued is routinely found by a Codex process draining after its own
 * success. That is not a mismatch to punish: it is somebody else's write, and
 * it waits for its own runtime. Only a write this runtime queued under a key
 * it no longer holds is refused — replaying it under the new key would sign
 * it with an identity that did not make it.
 */
const replayContext = (item) => {
  if (!item.id) return 'no id'
  if (item.base !== BASE || item.agent !== AGENT) {
    const age = Date.now() - Date.parse(item.t)
    // No readable queued-at time would otherwise keep it forever.
    if (!Number.isFinite(age)) return 'no queued-at time'
    return age > FOREIGN_OUTBOX_TTL_MS
      ? 'no process for its runtime and instance replayed it in 30 days'
      : 'foreign'
  }
  return item.keyId === KEY_ID ? 'own' : 'queued under a key this runtime no longer uses'
}

/** A crashed replay worker must not strand its claimed file for a minute. */
const processingOwnerIsDead = (name) => {
  const pid = Number(new RegExp(`^${OUTBOX_PREFIX.replaceAll('.', '\\.') }processing-(\\d+)-`).exec(name)?.[1])
  if (!Number.isSafeInteger(pid) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Whether a queue file holds anything this process would act on. Another
 * runtime's writes can wait here for days; draining them just to put them back
 * would turn every write and every checkpoint into a full replay cycle.
 */
const holdsReplayable = (path) => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).some((line) => {
      try {
        return replayContext(JSON.parse(line)) !== 'foreign'
      } catch {
        return true // quarantined by replay
      }
    })
  } catch {
    return false
  }
}

const hasReplayableOutbox = () => {
  try {
    const dir = dirname(OUTBOX_PATH)
    return readdirSync(dir).some((name) =>
      ((name === basename(OUTBOX_PATH) || name.startsWith(`${OUTBOX_PREFIX}pending-`)) &&
        holdsReplayable(join(dir, name))) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp') && !name.endsWith('.ack')) ||
      name.startsWith(`${OUTBOX_PREFIX}ack-`),
    )
  } catch {
    return false
  }
}

/**
 * Send everything that was put aside, oldest first.
 *
 * Stops at the first transient failure and keeps the rest: the server is still
 * coming back, and draining into a restarting container would lose the queue
 * for the same reason it was written. A write the server actively rejects is
 * moved to a rejected sidecar with the response, never silently discarded.
 */
const flushOutbox = async () => {
  requireKey()
  let sent = 0
  let rejected = 0
  let waiting = 0
  const claimId = `${process.pid}-${randomUUID()}`
  let claimed = []
  try {
    claimed = await withOutboxLock(() => {
      const dir = dirname(OUTBOX_PATH)
      // Recover acknowledgements journaled before a crash between processing
      // file compaction and local ownership persistence.
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}ack-`) || !name.endsWith('.json')) continue
        const path = join(dir, name)
        try {
          const marker = JSON.parse(readFileSync(path, 'utf8'))
          if (updateRememberedOwnership(marker.path, marker.data)) rmSync(path, { force: true })
        } catch { /* retain the marker for the next recovery attempt */ }
      }
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}processing-`)) continue
        if (name.endsWith('.ack') || name.endsWith('.tmp')) continue
        const path = join(dir, name)
        try {
          if (
            processingOwnerIsDead(name) ||
            Date.now() - statSync(path).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)
          ) {
            renameSync(path, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
          }
        } catch { /* another recovery won the rename */ }
      }
      if (existsSync(OUTBOX_PATH) && statSync(OUTBOX_PATH).size > 0) {
        renameSync(OUTBOX_PATH, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
      }
      const paths = []
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}pending-`)) continue
        const from = join(dir, name)
        const to = join(dir, `${OUTBOX_PREFIX}processing-${claimId}-${randomUUID()}`)
        try {
          renameSync(from, to)
          paths.push(to)
        } catch { /* another replay process claimed it */ }
      }
      return paths
    })
  } catch {
    return { sent: 0, rejected: 0, left: existsSync(OUTBOX_PATH) ? 1 : 0, waiting: 0 }
  }

  const reject = (entry) => {
    if (TEST_FAIL_REJECT_PERSIST) throw new Error('test failpoint: rejected-sidecar persistence failed')
    appendFileSync(REJECTED_OUTBOX_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    rejected += 1
  }

  for (const processingPath of claimed) {
    let lines
    try {
      lines = readFileSync(processingPath, 'utf8').split('\n').filter(Boolean)
    } catch {
      continue
    }
    const kept = []
    let index = 0
    for (; index < lines.length; index += 1) {
    let item
    try {
      item = JSON.parse(lines[index])
    } catch {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: 'invalid JSON', raw: lines[index] })
      } catch {
        break
      }
      continue
    }
    const context = replayContext(item)
    if (context === 'foreign') {
      kept.push(lines[index])
      waiting += 1
      continue
    }
    if (context !== 'own') {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: `replay context mismatch: ${context}`, item })
      } catch {
        break
      }
      continue
    }
    let res
    try {
      res = await fetch(`${BASE}${item.path}`, {
        method: item.method,
        headers: authHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': item.id,
          'X-Cairn-Queued-At': item.t,
        }),
        body: item.body === undefined ? undefined : JSON.stringify(item.body),
      })
    } catch {
      break // still unreachable
    }
    if (TRANSIENT.has(res.status)) break
    let response = ''
    try {
      response = await res.text()
    } catch {
      response = '<response unavailable>'
    }
    let acknowledgedData = null
    if (res.ok) {
      sent += 1
      try {
        const payload = JSON.parse(response)
        if (payload?.success) acknowledgedData = payload.data
      } catch { /* a successful legacy endpoint may have no JSON body */ }
      if (TEST_CRASH_AFTER_SEND) process.kill(process.pid, 'SIGKILL')
    } else {
      try {
        reject({ rejectedAt: new Date().toISOString(), status: res.status, response: response.slice(0, 2_000), item })
      } catch {
        break
      }
    }
    const remaining = [...kept, ...lines.slice(index + 1)]
    const temp = `${processingPath}.tmp`
    if (TEST_FAIL_PERSIST_AFTER_SEND) throw new Error('test failpoint: replay persistence failed')
    const isCheckpoint = item.path.split('?')[0].endsWith('/checkpoint')
    const ackPath = `${OUTBOX_PREFIX}ack-${randomUUID()}.json`
    if (acknowledgedData && isCheckpoint) {
      writeFileSync(join(dirname(OUTBOX_PATH), ackPath), `${JSON.stringify({ path: item.path, data: acknowledgedData })}\n`, { mode: 0o600 })
    }
    writeFileSync(temp, remaining.length ? `${remaining.join('\n')}\n` : '', { mode: 0o600 })
    renameSync(temp, processingPath)
    if (TEST_CRASH_AFTER_RENAME_BEFORE_STATE && acknowledgedData && isCheckpoint) process.kill(process.pid, 'SIGKILL')
    // Advance local checkpoint state only after the acknowledged record has
    // been durably removed from the processing file. Otherwise a local
    // persistence failure leaves a phantom sequence gap for the next queue.
    if (acknowledgedData && isCheckpoint && updateRememberedOwnership(item.path, acknowledgedData)) {
      rmSync(join(dirname(OUTBOX_PATH), ackPath), { force: true })
    }
  }

    const left = [...kept, ...lines.slice(index)]
    if (left.length > 0) {
      try {
        // In front of whatever was queued while this replay ran: those are
        // newer, and a checkpoint sent ahead of an older one breaks its sequence.
        await withOutboxLock(() => {
          if (TEST_ENQUEUE_DURING_REPLAY) appendFileSync(OUTBOX_PATH, `${TEST_ENQUEUE_DURING_REPLAY}\n`, { mode: 0o600 })
          let newer = ''
          try { newer = readFileSync(OUTBOX_PATH, 'utf8') } catch { /* nothing queued meanwhile */ }
          const temp = `${OUTBOX_PATH}.requeue.tmp`
          writeFileSync(temp, `${left.join('\n')}\n${newer}`, { mode: 0o600 })
          renameSync(temp, OUTBOX_PATH)
        })
      } catch {
        continue
      }
    }
    rmSync(processingPath, { force: true })
  }

  let left = 0
  try { left = readFileSync(OUTBOX_PATH, 'utf8').split('\n').filter(Boolean).length } catch { /* empty */ }
  for (const path of claimed) if (existsSync(path)) {
    try { left += readFileSync(path, 'utf8').split('\n').filter(Boolean).length } catch { /* retry later */ }
  }
  return { sent, rejected, left, waiting }
}

/**
 * Set by the first non-GET request. Read only by the ignored-flag report,
 * which has to know whether failing is safe: a read that ignored a filter
 * returned an answer nobody should trust and has done nothing, so exiting
 * non-zero is free. A write that ignored a flag has already happened, and
 * exiting non-zero would invite a caller to retry it.
 */
let mutated = false

/**
 * Keep this instance's list of project keys fresh enough to route a ref by
 * (resolveRoute). Only this instance's own server is asked, with its own key,
 * after it has already answered; at most every six hours, or at once after a
 * project was created or rekeyed. A failure keeps the old list.
 */
const PROJECT_KEYS_TTL_MS = 6 * 60 * 60 * 1000
let refreshingKeys = false
const refreshProjectKeys = async (force) => {
  if (!INSTANCE.name || refreshingKeys) return
  const path = join(STATE_DIR, PROJECT_KEYS_FILE)
  try {
    if (!force && Date.now() - statSync(path).mtimeMs < PROJECT_KEYS_TTL_MS) return
  } catch { /* never fetched */ }
  refreshingKeys = true
  try {
    const res = await fetch(`${BASE}/api/v1/projects?archived=1`, {
      headers: authHeaders(),
      // A hint, so never allowed to hold up the answer longer than the answer itself could.
      signal: AbortSignal.timeout(Math.min(DEADLINE_MS, 3_000)),
    })
    const payload = await res.json()
    if (!payload?.success || !Array.isArray(payload.data)) return
    const keys = [...new Set(payload.data.flatMap((p) => [p.key, ...(p.former_keys ?? []).map((f) => f.key)]).filter(Boolean))]
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), keys })}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch {
    // A routing hint, never worth failing the command that earned it.
  } finally {
    refreshingKeys = false
  }
}

const request = async (method, path, body, { soft = false } = {}) => {
  requireKey()
  if (method !== 'GET') mutated = true
  const isCheckpoint = path.split('?')[0].endsWith('/checkpoint')
  // A fresh checkpoint must not jump ahead of older durable checkpoints. Drain
  // first so the remembered sequence advances before this request is formed.
  if (!FLUSHING && isCheckpoint && hasReplayableOutbox()) {
    FLUSHING = true
    try { await flushOutbox() } finally { FLUSHING = false }
  }
  const taskState = rememberedTaskState(path)
  if (taskState && body && typeof body === 'object') {
    body = { ...body, ownershipVersion: taskState.ownershipVersion }
    if (isCheckpoint) body.checkpointVersion = taskState.checkpointVersion
  }
  let res
  const startedAt = Date.now()
  const spent = () => Date.now() - startedAt

  // A write that cannot get through is put aside rather than waited on. Only
  // ones whose answer the caller does not need; everything else fails fast,
  // which is still far better than blocking for minutes.
  const giveUp = (why) => {
    if (method !== 'GET' && QUEUEABLE.test(path.split('?')[0])) {
      if (path.split('?')[0].endsWith('/checkpoint') && rememberedOwnership(path) === null) {
        die(`${why}; checkpoint cannot be queued without a known ownership generation`)
      }
      return enqueue(method, path, body, why)
    }
    die(`${why} (${Math.round(spent() / 1000)}s)`)
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`cannot reach ${BASE}: ${error.message}`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    if (TRANSIENT.has(res.status)) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`${BASE} returned ${res.status} — it is probably restarting`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    break
  }

  warnIfStale(res)

  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (soft) return null
    die(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!payload.success) {
    // `soft` callers are probing, not asserting. `cairn know <word>` tries the
    // word as a slug first and falls back to searching, and dying on the miss
    // made the fallback unreachable.
    if (soft) return null
    // Surface the server's guidance verbatim — it names valid enum values and,
    // on a refused close, suggests a resolution. Swallowing that would turn a
    // useful round-trip into a wasted one.
    // A refused write names what it could not resolve. Printing only
    // `error` would hand back "some references did not resolve" and drop the
    // list of what they were and what the store actually calls them.
    const refs = [
      ...(payload.unresolvedReferences ?? []).map(
        (r) => `  [[${r.ref ?? r}]]${r.suggestions?.length ? ` — did you mean ${r.suggestions.join(', ')}?` : ''}`,
      ),
      ...(payload.taskReferences ?? []).map((r) => `  [[${r}]] is a task ref — write it bare as ${String(r).toUpperCase()}`),
    ]
    const extra = refs.length
      ? `\n${refs.join('\n')}`
      : payload.suggestedResolution
      ? `\nsuggested: ${payload.suggestedResolution}`
      : payload.issues
        ? `\n${payload.issues
            .map((i) => `  ${(i.path ?? []).join('.') || '(body)'}: ${i.message}`)
            .join('\n')}`
        : ''
    // The server names the rule and the line, never the value (CAIRN-285).
    // What to do instead is the part worth adding.
    const hint = payload.code === 'secret_detected'
      ? '\n  write where it lives instead: `$ENV_VAR`, `process.env.X`, a vault path, or `<password>`.' +
        '\n  if it was a real credential, rotate it: it has already been in this transcript.'
      : ''
    // 409 gets its own exit code so a caller can branch on "someone else has it".
    die(`${payload.error}${extra}${hint}`, payload.code === 'already_claimed' ? 9 : 1)
  }

  // Any response reached through a retired key says so here, once, rather than
  // each verb remembering to — the gap CAIRN-264 was, verb by verb.
  const told = payload.data
  if (told && typeof told === 'object' && !Array.isArray(told) && told.renamed_from) {
    tellRename(told.requested_ref, told.renamed_from, refOfTask(told))
  }

  await refreshProjectKeys(method !== 'GET' && path.startsWith('/api/v1/projects'))

  // Recorded here rather than at each call site: one place that already knows
  // the method, the path and that the server said yes.
  if (method !== 'GET') {
    rememberWrite(method, path, payload.data)
    updateRememberedOwnership(path, payload.data)
    // The server just answered, so anything put aside while it was down can go
    // now. No cron and nothing to remember to run: the next write drains it.
    if (!FLUSHING && hasReplayableOutbox()) {
      FLUSHING = true
      try {
        const { sent } = await flushOutbox()
        if (sent > 0) process.stderr.write(`replayed ${sent} queued write(s)\n`)
      } finally {
        FLUSHING = false
      }
    }
  }
  return payload.data
}

/**
 * The server validates against a MIME allowlist, and a Blob with no `type`
 * arrives as application/octet-stream — so every legitimate upload would be
 * rejected. Node has no mime lookup built in, so infer from the extension.
 */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', tar: 'application/x-tar',
  gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

const mimeOf = (filePath) => {
  const ext = filePath.toLowerCase().split('.').pop()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const upload = async (path, filePath) => {
  requireKey()
  if (!existsSync(filePath)) die(`no such file: ${filePath}`)

  const form = new FormData()
  // Let fetch set the multipart boundary; do not send a Content-Type header.
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeOf(filePath) }), basename(filePath))

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  }).catch((error) => die(`cannot reach ${BASE}: ${error.message}`))

  const payload = await res.json().catch(() => null)
  if (!payload?.success) {
    die(payload?.error ?? `upload failed with ${res.status}`)
  }
  return payload.data
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const flatten = (value, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined || v === '') continue // omit nulls entirely
    if (Array.isArray(v)) {
      if (!v.length) continue
      // An array of objects joined with a comma is a row of "[object Object]".
      // Index them instead, so `findings.0.note` is readable and greppable.
      if (v.some((item) => item && typeof item === 'object')) {
        v.forEach((item, i) => flatten(item, `${key}.${i}`, out))
      } else {
        out[key] = v.join(',')
      }
    } else if (typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

const emit = (data, opts = {}) => {
  if (FORMAT === 'json') return console.log(JSON.stringify(data, null, 2))
  if (FORMAT === 'pretty') return console.log(JSON.stringify(data, null, 2))

  // Some answers are sentences, not a table. Forcing them through the
  // key/value flattener turns a finding worth reading into nine numbered rows
  // nobody reads.
  if (opts.lines) {
    for (const line of opts.lines(data)) console.log(line)
    return
  }

  const rows = opts.rows ? opts.rows(data) : Array.isArray(data) ? data : null
  if (!rows) {
    const flat = flatten(data)
    for (const [k, v] of Object.entries(flat)) console.log(`${k}\t${v}`)
    return
  }

  console.log(`#${rows.length}`) // count first: paginate before parsing
  if (rows.length === 0) return
  const flatRows = rows.map((r) => flatten(r))
  const cols = opts.columns ?? [...new Set(flatRows.flatMap((r) => Object.keys(r)))]
  console.log(cols.join('\t'))
  for (const r of flatRows) console.log(cols.map((c) => r[c] ?? '').join('\t'))
}

/** Comma or repeated-flag list, e.g. --label a,b --label c. */
/**
 * Which Cairn project a directory belongs to.
 *
 * The server can guess from sessions already recorded against a cwd, but only
 * after the first one. This is the explicit answer, kept next to the
 * credentials: a longest-prefix map in ~/.cairn/projects.json, so a monorepo
 * subdirectory can override its parent.
 */
const PROJECT_MAP_PATH = join(STATE_DIR, 'projects.json')
const OWNERSHIP_DIR = join(STATE_DIR, 'ownership')

const ownershipPath = (ref) => join(OWNERSHIP_DIR, `${ref.toUpperCase().replace(/[^A-Z0-9-]/g, '_')}.json`)

const rememberedTaskState = (path) => {
  const raw = /\/api\/v1\/tasks\/([^/?]+)\/(?:beat|checkpoint|release)$/.exec(path)?.[1]
  if (!raw) return null
  try {
    const value = JSON.parse(readFileSync(ownershipPath(decodeURIComponent(raw)), 'utf8'))
    if (!Number.isSafeInteger(value?.ownershipVersion)) return null
    return {
      ownershipVersion: value.ownershipVersion,
      checkpointVersion: Number.isSafeInteger(value?.checkpointVersion) ? value.checkpointVersion : 0,
    }
  } catch {
    return null
  }
}

const rememberedOwnership = (path) => rememberedTaskState(path)?.ownershipVersion ?? null

/** Count earlier durable checkpoints so each queued write reserves one sequence. */
const pendingCheckpointCount = (path, ownershipVersion) => {
  const endpoint = path.split('?')[0]
  let count = 0
  try {
    const dir = dirname(OUTBOX_PATH)
    const names = readdirSync(dir).filter((name) =>
      name === basename(OUTBOX_PATH) ||
      name.startsWith(`${OUTBOX_PREFIX}pending-`) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp')),
    )
    for (const name of names) {
      let lines = []
      try { lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          if (
            item.base === BASE &&
            item.agent === AGENT &&
            item.path?.split('?')[0] === endpoint &&
            item.body?.ownershipVersion === ownershipVersion
          ) count += 1
        } catch { /* malformed records are quarantined by replay */ }
      }
    }
  } catch { /* no outbox yet */ }
  return count
}

const updateRememberedOwnership = (path, data) => {
  const match = /\/api\/v1\/tasks\/([^/?]+)\/(claim|checkpoint|release)$/.exec(path)
  if (!match) return false
  const target = ownershipPath(decodeURIComponent(match[1]))
  try {
    mkdirSync(OWNERSHIP_DIR, { recursive: true })
    if (match[2] === 'release') { rmSync(target, { force: true }); return true }
    const version = Number(data?.ownership_version)
    const checkpointVersion = Number(data?.checkpoint_version)
    if (!Number.isSafeInteger(version)) return false
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({
      ownershipVersion: version,
      checkpointVersion: Number.isSafeInteger(checkpointVersion) ? checkpointVersion : 0,
      agent: AGENT,
    })}\n`, { mode: 0o600 })
    renameSync(temp, target)
    return true
  } catch {
    // The server remains authoritative. Missing local context makes an offline
    // checkpoint fail closed instead of guessing an ownership generation.
    return false
  }
}

/**
 * A breadcrumb per successful write, so a session does not have to be guessed at.
 *
 * The session-end hook used to recover task refs with a regex over the
 * transcript, preferring refs on a line that also contained a `cairn` command.
 * A good heuristic, and still a guess: a dry run returned CAI-42 and
 * LEGACY-1164 — refs out of documentation examples — instead of the tasks the
 * session actually worked. Those links feed search, and a session linked to
 * everything answers yes to everything, which is the same as knowing nothing.
 *
 * This end knows exactly what it acted on and whether the server accepted it.
 *
 * It was keyed on time alone, because Codex and OpenClaw name sessions in ways
 * this process could not see while every runtime agrees on a clock. Time alone
 * is not enough once several sessions share the clock: the hook filtered the
 * window by directory and, when nothing matched, fell back to the whole
 * window -- so one session's writes were attributed to another's transcript.
 * A session working on a trading bot was told it was holding a knowledge-map
 * task, and two map tasks were stamped with a checkpoint about HERMES-107.
 *
 * So the session id goes in the breadcrumb when there is one, and the hook
 * filters on it exactly. A runtime that cannot name itself writes no session
 * and keeps the old behaviour; nothing is lost that was previously correct.
 */
const ACTED_PATH = join(CAIRN_DIR, 'acted.jsonl')
const ACTED_MAX_BYTES = 256 * 1024
const ACTED_KEEP_LINES = 2000

/** Which ref a write acted on, from the server's answer or failing that the path. */
const refOfWrite = (path, data) => {
  const fromBody = typeof data?.ref === 'string' ? data.ref : null
  if (fromBody && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(fromBody)) return fromBody
  const fromPath = /\/api\/v1\/tasks\/([^/?]+)/.exec(path)?.[1]
  if (!fromPath) return null
  const decoded = decodeURIComponent(fromPath).toUpperCase()
  return /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(decoded) ? decoded : null
}

/** `claim`, `note`, `done` — the sub-resource, or the method when there is none. */
const verbOfWrite = (method, path) => {
  const tail = /\/api\/v1\/tasks\/[^/?]+\/([a-z-]+)/.exec(path)?.[1]
  if (tail) return tail
  if (path.includes('/tasks') && method === 'POST') return 'add'
  return { POST: 'add', PATCH: 'update', DELETE: 'delete' }[method] ?? method.toLowerCase()
}

/**
 * Append-only and self-trimming. A file that grows forever on a machine an
 * agent writes to every few seconds is a slow leak, and one that is rewritten
 * on every call would lose a concurrent write from a sibling agent.
 */
const rememberWrite = (method, path, data) => {
  const ref = refOfWrite(path, data)
  if (!ref) return
  try {
    mkdirSync(dirname(ACTED_PATH), { recursive: true })
    if (existsSync(ACTED_PATH) && statSync(ACTED_PATH).size > ACTED_MAX_BYTES) {
      const kept = readFileSync(ACTED_PATH, 'utf8').trim().split('\n').slice(-ACTED_KEEP_LINES)
      writeFileSync(ACTED_PATH, `${kept.join('\n')}\n`)
    }
    appendFileSync(
      ACTED_PATH,
      `${JSON.stringify({
        t: new Date().toISOString(),
        ref,
        verb: verbOfWrite(method, path),
        cwd: process.cwd(),
        agent: AGENT,
        // Machine-wide, because the session-end hook reads it before it knows
        // which instance a session belongs to.
        ...(INSTANCE.name ? { instance: INSTANCE.name } : {}),
        // Absent on a runtime that cannot name its session. The hook treats
        // absent as "cannot tell", never as "not mine".
        ...(SESSION ? { session: SESSION } : {}),
      })}\n`,
    )
  } catch {
    // A breadcrumb is a convenience for the hook. Never fail a write over one.
  }
}

/** HOL-113 from a full task row or a digest, whichever this is. */
const refOfTask = (data) => {
  if (typeof data?.ref === 'string') return data.ref
  const key = data?.project?.key ?? data?.projects?.key
  return key && data?.number !== undefined ? `${key}-${data.number}` : undefined
}

/**
 * Mappings that name a key the project no longer has.
 *
 * They keep working — the server resolves a retired key — but every briefing
 * and `next` from that directory then goes through the old name, and an agent
 * reading "[AC]" files new work under a key that no longer exists as far as
 * anyone else can see (CAIRN-264). One soft call, so an older server or a
 * network failure leaves `cairn map` exactly as it was.
 */
const warnRetiredMappings = async (map) => {
  const keys = new Set(Object.values(map))
  if (keys.size === 0) return
  const projects = await request('GET', '/api/v1/projects?archived=1', undefined, { soft: true })
  if (!Array.isArray(projects)) return
  const liveFor = new Map()
  for (const p of projects) for (const f of p.former_keys ?? []) liveFor.set(f.key, { to: p.key, at: f.retired_at })
  for (const [path, k] of Object.entries(map)) {
    const now = liveFor.get(k)
    if (!now) continue
    process.stderr.write(
      `warning: ${path} is mapped to ${k}, which was renamed ${now.to} on ${renameDay(now.at)}. ` +
        `It still resolves; run \`cairn map ${now.to}\` there to update it.\n`,
    )
  }
}

const readProjectMap = () => {
  try {
    return JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const projectForDir = (dir) => {
  const map = readProjectMap()
  let best = null
  for (const [path, key] of Object.entries(map)) {
    if ((dir === path || dir.startsWith(`${path}/`)) && (!best || path.length > best[0].length)) {
      best = [path, key]
    }
  }
  return best?.[1] ?? null
}

const git = (dir, args) => {
  try {
    return (
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

const gitRoot = (dir) => git(dir, ['rev-parse', '--show-toplevel'])

/**
 * The repository this directory belongs to, as the server will know it.
 *
 * `origin` because that is what a clone writes. Sent raw: reducing spellings
 * to one repository is the server's rule, so the CLI, the MCP facade and an
 * import cannot drift apart on it.
 */
const gitRemote = (dir) => git(dir, ['remote', 'get-url', 'origin'])

/**
 * Deliberately not read on the resolution path: `rev-list --max-parents=0`
 * walks the whole history, which is milliseconds here and seconds on a large
 * repository, and the briefing hook can afford neither.
 */
const gitRootCommit = (dir) => git(dir, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').pop()

const splitList = (v) => {
  if (v === undefined || v === true) return []
  const parts = Array.isArray(v) ? v : [v]
  return parts.flatMap((p) => String(p).split(',')).map((x) => x.trim()).filter(Boolean)
}

/**
 * The briefing, as text a model reads once at the top of a session.
 *
 * Ordered by what changes behaviour soonest: what you are still holding, then
 * what is moving around you, then where the last session stopped, then what is
 * known here. Anything with nothing to say prints nothing at all -- an empty
 * heading is noise that trains the reader to skip the block.
 */
const renderContext = (d, { fileOnly = false } = {}) => {
  const out = []

  // A file read is a narrow question. Answering it with the whole project
  // briefing, on every Read, is how an injection channel becomes noise the
  // reader learns to skip -- and then the one time it matters, it is skipped.
  if (fileOnly) {
    const f = d.file
    if (!f || (!f.tasks.length && !f.knowledge.length)) return ''
    out.push(`## Cairn knows about ${f.path}`)
    for (const t of f.tasks) {
      out.push(`  ${t.ref}  ${t.status}${t.resolved ? ' (answered)' : ''}  ${truncate(t.title, 54)}`)
    }
    for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 54)}`)
    for (const sn of f.sessions.slice(0, 1)) {
      if (sn.nextSteps) out.push(`  last session here: ${truncate(sn.nextSteps, 160)}`)
    }
    return `${out.join('\n')}\n`
  }

  const where = d.project ? `[${d.project}]` : '[unfiled]'
  out.push(`## Cairn ${where}`)

  // This checkout is mapped to a key the project no longer has. The briefing
  // is for the live project either way; saying so is what stops the next agent
  // filing "AC-…" refs into its notes for another month.
  if (d.projectRenamed) {
    const r = d.projectRenamed
    out.push(
      `  ${r.key} was renamed ${r.to} on ${renameDay(r.at)} -- ${r.key}-n refs still resolve; ` +
        `write ${r.to}-n, and run \`cairn map ${r.to}\` here to update this checkout.`,
    )
  }

  if (d.held?.length) {
    out.push('', 'You are holding:')
    for (const t of d.held) {
      const quiet = t.quiet ? '  <- no note in 24h; checkpoint or release it' : ''
      // A recent rename, beside the ref it changed: the agent that wrote
      // AC-113 in yesterday's notes must recognise HOL-113 as the same task.
      const was = t.was?.length ? ` (was ${t.was.join(', ')})` : ''
      out.push(`  ${t.ref}${was}  ${t.status}  ${truncate(t.title, 58)}${quiet}`)
    }
  }

  if (d.inFlight?.length) {
    // Separated on purpose. "In flight" reads as work someone is on, and a
    // dropped task sitting in that list looked exactly like a live one --
    // which is how ten of them accumulated without anyone noticing.
    const live = d.inFlight.filter((t) => !t.stalled)
    const stalled = d.inFlight.filter((t) => t.stalled)

    if (live.length) {
      out.push('', 'In flight here:')
      for (const t of live) {
        const who = t.claimedBy ? `  (${t.claimedBy})` : ''
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 52)}${who}`)
      }
    }

    if (stalled.length) {
      out.push('', 'Started and dropped here -- nobody is on these:')
      for (const t of stalled) {
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 44)}  quiet ${t.quietFor}`)
      }
      out.push('  Finish one and close it with a resolution, or move it back to todo.')
    }
  }

  if (d.lastSession?.nextSteps) {
    out.push('', `Last session here left off (${d.lastSession.agent ?? 'unknown'}):`)
    out.push(`  ${truncate(d.lastSession.nextSteps, 400)}`)
  }

  if (d.knowledge?.length) {
    out.push('', 'Known here (cairn know <slug>):')
    for (const k of d.knowledge) {
      out.push(`  ${k.slug}${factMark(k) ? `  [${factMark(k)}]` : ''}  -- ${truncate(k.title, 58)}`)
    }
  }

  if (d.staleClaims?.length) {
    out.push('', 'Stale claims (lease expired, takeable):')
    for (const t of d.staleClaims) out.push(`  ${t.ref}  held ${t.heldFor} by ${t.claimedBy}`)
  }

  if (d.file) {
    const f = d.file
    if (f.tasks.length || f.knowledge.length) {
      out.push('', `About ${f.path}:`)
      for (const t of f.tasks) out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 56)}`)
      for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 56)}`)
    }
  }

  if (out.length === 1) return ''
  out.push('', ...BRIEFING_RULES)
  return `${out.join('\n')}\n`
}

/**
 * The one text every Claude Code and Codex session is shown unasked, and for
 * months it carried a single rule. The habits the scorecard found missing
 * (CAIRN-294) are each one line here; kept under 300 bytes so the briefing
 * stays a briefing.
 */
const BRIEFING_RULES = [
  'Start with: cairn check "<subject>". Claim what you work (agents\' add claims it); one task per sweep.',
  'Dead end: note --kind attempt. Before yielding: checkpoint. Not landed: update --status in-review.',
  'Close: done --kind fixed|verified|answered.',
]

const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * How far to trust a fact, in one word. `stale` is evidence: sessions reworked
 * the files it names. `unverified Nd` is only age, for a fact that names no
 * file (CAIRN-289), and is worded apart so it never reads as the first.
 */
const factMark = (k) =>
  k.stale ? 'stale' : k.unverified_days ? `unverified ${k.unverified_days}d` : ''

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const HELP = `cairn — agent-first task tracker and shared memory

  ALWAYS START HERE
    cairn check "<subject>"        what has already been done or debugged
                                   searches tasks, work-log notes, knowledge and
                                   sessions; --kinds task,note,knowledge,session

  read
    cairn next [--project K]       what to pick up, and why — ranked, never blocked
    cairn list [--project K] [--status S] [--type T] [--label L] [--mine]
    cairn show <ref>               e.g. CAI-42
    cairn log <ref> [--kind K]     the work log
    cairn projects

  write
    cairn add "<title>" --project K [--type bug] [--priority high] [--body -]
    cairn add ... --start          file it and claim it, when you are starting now
                                   (the default for an agent runtime, unless it
                                   already holds work here or similar open work
                                   exists; --no-start to only file it)
    cairn update <ref> [--title T] [--status S] [--type T] [--priority P]
    cairn update <ref> --also-project HM,AT      work that spans several projects
    cairn update <ref> --project OTHER      moves it; the ref changes
    cairn note <ref> "<text>" [--kind note|finding|decision|attempt|handoff]
    cairn commit <ref> <sha> [--repo PATH] [--branch NAME] [--message TEXT] [--url URL]
    cairn push <ref> <sha> [--repo PATH] [--branch NAME] [--remote NAME] [--url URL]
    cairn run <ref> "<command>" --status passed|failed|skipped [--exit-code N]
                                   these three RECORD what you already did;
                                   none of them runs anything. Recording the
                                   same commit twice is one line, not two.
    cairn comment <ref> "<text>"
    cairn done <ref> --resolution "<what was actually done>" [--kind fixed|verified|answered|…]
    cairn cancel <ref> --resolution "<why it is being dropped>" [--kind wont-fix]
    cairn done <ref> --duplicate-of CAI-31 --resolution "…"   points at the original
    cairn attach <ref> <file>      |   cairn files <ref>

  sub-tasks
    cairn add "<title>" --project K --parent CAI-42   file it under an existing task
    cairn children <ref>                    the direct split
    cairn update <ref> --parent CAI-42 | --no-parent

  history
    cairn history <ref>                     what changed, when, and who changed it

  dependencies
    cairn deps <ref>                        what blocks this, and what it blocks
    cairn blockedby <ref> <other>           mark <ref> as blocked by <other>
    cairn unblockedby <ref> <other>         remove that link

  labels
    cairn labels                            every label in use, busiest first
    cairn labels rename <from> <to>         renaming onto an existing label merges them
    cairn labels remove <label>

  projects
    cairn map [<KEY>|none]                       which project this directory is
    cairn instance [list]                        which Cairn instance a command uses, and all of them
    cairn instance add <name> --url <url> [--default] [--adopt]
                                                 configure one more; --adopt moves this machine's
                                                 existing env, map, ownership and queue into it
    cairn <command> --instance <name>            use that instance (or CAIRN_INSTANCE=<name>)
    cairn route                                  which instance this directory uses, and why
    cairn route add <instance> [--folder|--session] [--dir D] [--force]
                                                 save the answer: this repository (or directory),
                                                 everything under it, or this session only
    cairn route list | pending | remove [--folder] [--dir D]
    cairn --version                              this CLI, the server, and whether they match
    cairn projects [--archived]                  --archived includes retired ones;
                                                 \`was\` lists keys a project used to have
    cairn project create <KEY> "<title>" [--body -]   KEY is 2-10 uppercase
    cairn project rename <KEY> "<title>"
    cairn project rekey <KEY> <NEW>              change the key; old refs keep resolving
    cairn project rename <KEY> --key <NEW>       the same, as entities spells it
    cairn project archive <KEY>                  hides it; the tasks stay searchable
    cairn project restore <KEY>
    cairn project delete <KEY> --confirm <KEY>   deletes every task in it
    cairn task delete <ref> --confirm <ref>       junk only; refuses a task with history

  memory
    cairn context [--scope project|all] [--project K]
                                   what you hold, what is in flight,
                                   where the last session here stopped, what is known;
                                   project scope filters tasks and sessions (default: all)
    cairn learn "<title>" --body - record what we now know
                                   --allow-dangling  keep a [[ref]] the store cannot resolve
                                   --files a,b  files it is about, beyond those its body names
                                   --project K  true of that project
                                   --entity E   true of that grouping (cairn entities)
                                   --global     true everywhere — say so on purpose
                                   none of them: inferred from this directory's
                                   project, and it refuses if there is none
    cairn entities                 groupings a fact can be true of, and their projects
    cairn entities assign|unassign <key> --project A,B
    cairn entities rename <key> --key <new> --title "T"
    cairn recall <ref>             decisions and knowledge that bear on this task, and why
    cairn know [<slug>|<query>]    read it back, or list what applies here
    cairn know --gaps              where the memory has holes
    cairn know --orphans           entries nothing links to, that link to nothing
    cairn know --dangling          references pointing at entries nobody wrote
    cairn know <slug> --history    every version, who changed it and why  [--full]
    cairn know --unused [--days 30]  facts no search or read has returned lately
    cairn know <slug> --sweep      a scripted read, kept out of recall counts (or CAIRN_SWEEP=1)
    cairn verify <slug>            it is still true — clears the stale mark
    cairn replay                   send writes put aside while the server was down
    cairn relearn <slug> --body -  correct it  [--reason "why"] [--allow-dangling]
                                   --project K | --entity E | --global  re-scope it
                                   (none clears one side: --entity E --project none moves it)
                                   --files a,b  the files it is about (replaces those named before)
    cairn unlearn <slug> [--superseded-by <slug> [--reason "why"]]
    cairn session list             recent sessions
    cairn session checkpoint --id <id>  upsert ongoing session, do not checkpoint held tasks
    cairn session end --id <id>    write the episodic record, checkpoint what is held
    cairn reconcile                release your own claims that went quiet (2h)
                                   as CAIRN_AGENT=maintenance: every quiet claim
    cairn vitals [--hours 24] [--all]   is the memory still being written
    cairn vitals --notify <ref>         post findings as a note, silent if none

  coordinate
    cairn claim <ref>              exits 9 if another agent holds it
    cairn beat <ref>               keep a claim alive
    cairn checkpoint <ref> --summary "<where things stand>"
    cairn release <ref> [--force]   --force only to drop another session's claim
    cairn block <ref> --reason "<why>"   |   cairn unblock <ref>

  output
    --json | --pretty              default is TSV: count line, header, rows
    --body -  /  --resolution -    read the value from stdin

  env: CAIRN_BASE_URL, CAIRN_API_KEY
`

const need = (v, msg) => (v === undefined || v === true ? die(msg) : v)

const DEAD_END = /\b(tried|no change|didn['’]?t work|did not work|no effect|made no difference|ruled out|dead[- ]end)\b/i

/** Shared by `done` and `cancel`: both close, and both must say how. */
const closeTask = async (status, defaultKind) => {
  const verb = status === 'done' ? 'done' : 'cancel'
  const ref = need(positional[0], `usage: cairn ${verb} <ref> --resolution "<why>"`)
  const resolution = await resolveValue(
    need(flags.resolution, 'a --resolution is required: say what was actually done, and why'),
  )
  const body = { status, resolution, resolutionKind: flags.kind ?? defaultKind }
  // Naming the original is what makes "duplicate" useful to whoever finds it.
  if (flags['duplicate-of']) {
    body.duplicateOf = flags['duplicate-of']
    body.resolutionKind = 'duplicate'
  }
  const closed = await request('PATCH', `/api/v1/tasks/${ref}`, body)
  emit(closed)
  if (FORMAT !== 'tsv' || status !== 'done') return

  // `fixed` is a claim of authorship, and it was being recorded for audits
  // and answers alike because it is what an omitted --kind means (CAIRN-148).
  if (!flags.kind && !body.duplicateOf) {
    process.stderr.write(
      `recorded as fixed — use --kind verified|answered|not-reproducible|superseded if that is not what happened\n`,
    )
  }

  // Said once, at the close, and only when nothing at all showed the work
  // being done: the same predicate as the vitals finding (migration 054), so
  // a sweep item with a commit against it, or one moved to in-review, is not
  // nagged. A person is documented as never claiming, so only a runtime is.
  if (!AGENT) return
  const events = await request('GET', `/api/v1/tasks/${ref}/activity?limit=500`, undefined, { soft: true })
  if (!Array.isArray(events)) return
  const TRACE = new Set(['claimed', 'checkpointed', 'git_commit', 'git_push', 'run_result'])
  const seen = events.some(
    (e) =>
      TRACE.has(e.event) ||
      (e.event === 'status_changed' && !['done', 'cancelled'].includes(e.data?.to ?? '')),
  )
  if (!seen) {
    process.stderr.write(
      `${refOfTask(closed) ?? ref} was closed without ever being claimed — nobody could see it being worked. ` +
        `Next time claim first (\`cairn add\` now claims for agents).\n`,
    )
  }
}

/** `from -> to`, or the raw keys, kept to one short cell. */
const summariseEvent = (data) => {
  if (!data || typeof data !== 'object') return ''
  if ('from' in data || 'to' in data) {
    const from = Array.isArray(data.from) ? data.from.join('|') : (data.from ?? '')
    const to = Array.isArray(data.to) ? data.to.join('|') : (data.to ?? '')
    return `${from} -> ${to}`
  }
  return Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

const commands = {
  async check() {
    const q = need(positional[0], 'usage: cairn check "<subject>"')
    const params = new URLSearchParams({ q })
    if (flags.project) params.set('project', flags.project)
    if (flags.type) params.set('type', flags.type)
    if (flags.kinds) params.set('kinds', flags.kinds)
    if (flags.tasks) params.set('tasksOnly', '1')
    const data = await request('GET', `/api/v1/search?${params}`)
    // The exact-ref hit, when the ref asked for used a retired key: said before
    // the table, so "AC-113" coming back as HOL-113 is not a mystery.
    for (const r of data.results ?? []) {
      if (r.renamedFrom) tellRename(r.requestedRef, r.renamedFrom, r.ref)
    }
    emit(data, {
      rows: (d) =>
        d.results.map((r) => ({
          kind: r.kind ?? 'task',
          ref: r.ref,
          // A stale fact is still current knowledge; what it is not is
          // confirmed. Said in the column already read for exactly that,
          // rather than as a column everyone learns to ignore.
          status: r.status === 'superseded' && !r.stale ? 'superseded' : factMark(r) || (r.status ?? ''),
          type: r.type ?? '',
          answered: r.resolved ? 'yes' : '',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
      columns: ['kind', 'ref', 'status', 'type', 'answered', 'tokens', 'title'],
    })
    if (FORMAT !== 'tsv') return

    if (data.results.length === 0) {
      process.stderr.write('nothing found — this subject looks new\n')
      return
    }

    // Widening only happens when the precise query came back thin, so a result
    // set that is entirely loose means nothing actually matched the subject.
    // Without saying so, twenty plausible-looking rows read as prior work.
    const loose = data.results.filter((r) => r.loose).length
    if (loose === data.results.length) {
      process.stderr.write(
        `no precise match — all ${loose} rows are loose word overlaps, so treat this subject as new unless one genuinely fits\n`,
      )
    } else if (loose > 0) {
      process.stderr.write(`${data.results.length - loose} precise, ${loose} loose\n`)
    }
  },

  async list() {
    const project = need(flags.project ?? positional[0], 'usage: cairn list --project <KEY>')
    const params = new URLSearchParams()
    for (const k of ['status', 'type', 'label', 'limit', 'offset']) {
      if (flags[k]) params.set(k, flags[k])
    }
    // The server resolves who "mine" is. This used to send
    // `claimed_by=$CAIRN_AGENT`, which guessed the caller from an environment
    // variable and, when it was unset, asked for tasks held by the empty
    // string -- an answer that looked like an answer.
    if (flags.mine) params.set('mine', 'true')
    const data = await request('GET', `/api/v1/projects/${project}/tasks?${params}`)
    emit(data, {
      rows: (d) =>
        d.tasks.map((t) => ({
          ref: `${t.project?.key ?? project}-${t.number}`,
          status: t.status,
          type: t.type,
          priority: t.priority,
          held: t.claimed_by ?? '',
          answered: t.resolution ? 'yes' : '',
          title: truncate(t.title, 70),
        })),
      columns: ['ref', 'status', 'type', 'priority', 'held', 'answered', 'title'],
    })
  },

  async show() {
    const ref = need(positional[0], 'usage: cairn show <ref>')
    // A digest by default: the answer in full, findings and decisions, a
    // clipped body, and a note of what was withheld. `--full` for everything.
    const suffix = flags.full ? '' : '?view=digest'
    const data = await request('GET', `/api/v1/tasks/${ref}${suffix}`)
    emit(data)
    if (FORMAT === 'tsv' && data.omitted) {
      const { descriptionBytes, attemptsAndNotes, tokensToFetchFull } = data.omitted
      if (descriptionBytes || attemptsAndNotes) {
        process.stderr.write(
          `withheld: ${descriptionBytes}B of body, ${attemptsAndNotes} attempt/note(s)` +
            ` — cairn show ${ref} --full is ~${tokensToFetchFull} tokens\n`,
        )
      }
    }
  },

  async projects() {
    const suffix = flags.archived ? '?archived=1' : ''
    const data = await request('GET', `/api/v1/projects${suffix}`)
    if (FORMAT !== 'tsv') return emit(data)
    // `was` is the keys a project used to have, space-separated, and it is the
    // LAST column: readers of this table (trig's connector among them) key on
    // the header, and a column appended at the end is one they never see move.
    // When they were retired, and by whom, is in --json as `former_keys`.
    const rows = data.map(({ former_keys: former, ...rest }) => ({
      ...rest,
      was: (former ?? []).map((f) => f.key).join(' '),
    }))
    const columns = [
      ...new Set(rows.flatMap(({ was: _was, ...rest }) => Object.keys(flatten(rest)))),
      'was',
    ]
    emit(rows, { columns })
  },

  async add() {
    const title = need(positional[0], 'usage: cairn add "<title>" --project <KEY>')
    const project = need(flags.project, 'a --project is required')

    /**
     * A bug or a spike with no body is not yet a report — it is a title.
     *
     * Measured before this existed: 23% of tasks filed in a month had an empty
     * description, and it split by author rather than by subject — 51% for one
     * agent, 75% for another, 0% for tasks filed by a human through the UI. The
     * same agents write a resolution on every single close, because `done`
     * refuses without one. Guidance alone had not moved it; a refusal had.
     *
     * Only where the body carries the value. A chore is often fully described
     * by its title, and demanding prose there teaches people to type "n/a",
     * which is worse than an empty field because it looks answered.
     */
    // Resolved once, here: `--body -` reads stdin, which cannot be read twice,
    // and both the check below and the request itself need the value.
    const described = flags.body ? String(await resolveValue(flags.body)) : undefined

    const NEEDS_BODY = new Set(['bug', 'spike'])
    if (NEEDS_BODY.has(flags.type) && !flags['force-empty']) {
      if ((described ?? '').trim().length < 40) {
        die(
          `a ${flags.type} needs a body: what happens, what you expected, and how to see it.\n` +
            '  cairn add "<title>" --project K --type ' + flags.type + ' --body -   # markdown on stdin\n' +
            '  ...--body "one line is fine when that is genuinely all there is"\n' +
            'If the title really is the whole story, pass --force-empty.',
        )
      }
    }

    // Warn on a near-duplicate rather than silently filing one.
    //
    // websearch_to_tsquery ANDs its terms, so passing the whole title finds
    // nothing unless a prior task shares every word. For a similarity check we
    // want the opposite, so OR the distinctive words together instead.
    const terms = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
    const probe = terms.length ? terms.join(' OR ') : title

    /**
     * An agent that files a task is, most of the time, about to do it.
     *
     * `--start` existed and was used on 37% of Claude Code's adds against 86%
     * for Codex, and 35% of Claude Code's closes had never been claimed
     * (CAIRN-294). A flag the caller has to remember is the discipline that
     * already failed, so for a runtime the default flips; a person filing
     * from a terminal is unchanged, as claim.ts already treats them.
     *
     * Not when this session already holds work in the project: that is a
     * follow-up filed mid-task, and claiming it too puts a second task in
     * `doing` that nobody is doing. Not when --status says where the task
     * goes. Not when similar open work exists — below.
     */
    const optedOut = Boolean(flags['no-start'])
    const autoStart = !flags.start && !optedOut && !flags.status && Boolean(AGENT)
    // Tasks only. "Has this already been filed" is a question about tasks, and
    // answering it with a session from three weeks ago is noise in front of the
    // one thing the agent is about to decide.
    const [dupes, mine] = await Promise.all([
      request('GET', `/api/v1/search?${new URLSearchParams({ q: probe, kinds: 'task' })}`),
      autoStart
        ? request('GET', `/api/v1/projects/${project}/tasks?mine=true&limit=5`, undefined, { soft: true })
        : null,
    ])
    if (dupes.results.length > 0) {
      process.stderr.write('similar existing work:\n')
      for (const r of dupes.results.slice(0, 3)) {
        process.stderr.write(`  ${r.ref} [${r.status}] ${r.title}\n`)
      }
    }
    // The probe ORs the title's words, so nearly every add finds *something*.
    // Holding the claim back on any hit would hold it back on every add; only
    // an open task sharing most of the title's distinctive words counts.
    const OPEN = new Set(['backlog', 'todo', 'doing', 'in-review'])
    const wordsOf = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))
    const mineWords = wordsOf(title)
    const sameWork = (other) => {
      const theirs = wordsOf(other)
      const shared = [...mineWords].filter((w) => theirs.has(w)).length
      return shared >= Math.max(2, Math.ceil(Math.min(mineWords.size, theirs.size) / 2))
    }
    const similarOpen = dupes.results
      .slice(0, 3)
      .find((r) => OPEN.has(r.status) && sameWork(r.title))
    const holding = (mine?.tasks ?? []).find((t) => t.claimed_by && OPEN.has(t.status))

    const body = { title }
    if (described !== undefined) body.description = described
    // The server holds the same rule now (CAIRN-291), so the escape hatch has
    // to travel with the request. An older server strips the unknown key.
    if (flags['force-empty']) body.forceEmpty = true

    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    if (flags.parent) body.parentRef = flags.parent
    const created = await request('POST', `/api/v1/projects/${project}/tasks`, body)

    // File-and-work-it-now is the pattern that skips claiming: the agent that
    // files a task and finishes it in the same session never perceives a
    // difference, so the board shows backlog while the work happens.
    if (flags.start) {
      const held = await request('POST', `/api/v1/tasks/${created.ref}/claim`, {})
      return emit({ ...created, status: held.status, claimed_by: held.claimed_by })
    }
    if (autoStart) {
      // Filed either way. Claiming on top of a possible duplicate would put two
      // tasks for one piece of work in `doing`, which is worse than neither.
      if (similarOpen) {
        process.stderr.write(
          `NOT CLAIMED: ${similarOpen.ref} [${similarOpen.status}] looks like the same work. ` +
            `Work that one, or \`cairn claim ${created.ref}\` if this really is new.\n`,
        )
      } else if (holding) {
        process.stderr.write(
          `not claimed: you already hold ${holding.project?.key ?? project}-${holding.number} here — ` +
            `\`cairn claim ${created.ref}\` if you are switching to this now\n`,
        )
      } else {
        // Soft: the task exists now, and a refused claim must not read as a
        // failed add that the caller then retries into a duplicate.
        const held = await request('POST', `/api/v1/tasks/${created.ref}/claim`, {}, { soft: true })
        if (held) {
          process.stderr.write(`claimed ${created.ref} (agents' adds start the work; --no-start to only file it)\n`)
          return emit({ ...created, status: held.status, claimed_by: held.claimed_by })
        }
        process.stderr.write(`filed ${created.ref} but could not claim it — \`cairn claim ${created.ref}\`\n`)
      }
    }
    emit(created)
  },

  async update() {
    const ref = need(positional[0], 'usage: cairn update <ref> --status <s>')
    const body = {}
    if (flags.title) body.title = flags.title
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    // Passed through so a single update can move to a closing status and say
    // how in one call — without it the API rightly refuses the move.
    if (flags.resolution) body.resolution = await resolveValue(flags.resolution)
    if (flags.kind) body.resolutionKind = flags.kind
    if (flags.parent) body.parentRef = flags.parent
    if (flags['no-parent']) body.parentRef = null
    // Moving renumbers the task, so the response reports the new ref.
    if (flags.project) body.project = flags.project
    // Widening does not: the task keeps its home project and its ref, and only
    // starts appearing in the other projects' lists and boards too.
    if (flags['also-project'] !== undefined) body.alsoProjects = splitList(flags['also-project'])
    if (flags['duplicate-of']) {
      body.duplicateOf = flags['duplicate-of']
      body.resolutionKind = 'duplicate'
    }
    emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
  },

  async done() {
    return closeTask('done', 'fixed')
  },

  /**
   * Cancelling is closing too. Without this the CLI could reach five of the
   * six statuses, and a task dropped on purpose had to be edited by hand.
   */
  async cancel() {
    return closeTask('cancelled', 'wont-fix')
  },

  async commit() {
    const ref = need(positional[0], 'usage: cairn commit <ref> <sha> [--repo PATH]')
    const sha = need(positional[1], 'a commit SHA is required')
    const payload = { event: 'git_commit', sha }
    if (flags.repo) payload.repo = flags.repo
    if (flags.branch) payload.branch = flags.branch
    if (flags.message) payload.message = await resolveValue(flags.message)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async push() {
    const ref = need(positional[0], 'usage: cairn push <ref> <sha> [--repo PATH]')
    const sha = need(positional[1], 'the pushed commit SHA is required')
    const payload = { event: 'git_push', sha }
    if (flags.repo) payload.repo = flags.repo
    if (flags.branch) payload.branch = flags.branch
    if (flags.remote) payload.remote = flags.remote
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async run() {
    const ref = need(positional[0], 'usage: cairn run <ref> "<command>" --status passed|failed|skipped')
    const command = await resolveValue(need(positional[1], 'the command is required'))
    const status = need(flags.status, '--status is required')
    if (!['passed', 'failed', 'skipped'].includes(status)) {
      die('--status must be passed, failed, or skipped')
    }
    const payload = { event: 'run_result', command, status }
    for (const [flag, field] of [['exit-code', 'exitCode'], ['duration-ms', 'durationMs']]) {
      if (flags[flag] !== undefined) payload[field] = Number(flags[flag])
    }
    if (flags.output !== undefined) payload.output = await resolveValue(flags.output)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async note() {
    const ref = need(positional[0], 'usage: cairn note <ref> "<text>"')
    const note = await resolveValue(need(positional[1], 'a note body is required'))
    const result = await request('POST', `/api/v1/tasks/${ref}/notes`, {
      note,
      kind: flags.kind ?? 'note',
    })
    emit(result)

    // A hint, not a reclassification: the words are a guess, and only the
    // writer knows. 19 of 1,469 Claude Code notes were `attempt` (CAIRN-294),
    // while "tried X, no change" is exactly what the next agent needs flagged.
    if (!flags.kind && FORMAT === 'tsv' && DEAD_END.test(note)) {
      process.stderr.write(
        `reads like a dead end — \`cairn note ${ref} "…" --kind attempt\` marks it so the next agent does not retry it\n`,
      )
    }

    // Said, not inferred. Writing a note used to claim the task, which put
    // work in `doing` that nobody was doing — annotating is most of what
    // reading a backlog is. Pointing at the claim leaves the judgement with
    // the only party that knows which of the two this was.
    if (result?.unclaimed && FORMAT === 'tsv') {
      process.stderr.write(
        `${ref} is open and unclaimed — \`cairn claim ${ref}\` if you are working it\n`,
      )
    }
  },

  async log() {
    const ref = need(positional[0], 'usage: cairn log <ref>')
    const suffix = flags.kind ? `?kind=${flags.kind}` : ''
    const data = await request('GET', `/api/v1/tasks/${ref}/notes${suffix}`)
    emit(data, {
      rows: (d) =>
        d.map((n) => ({
          kind: n.kind,
          by: n.actor_id,
          at: n.created_at.slice(0, 16).replace('T', ' '),
          note: truncate(n.note, 90),
        })),
      columns: ['kind', 'by', 'at', 'note'],
    })
  },

  async comment() {
    const ref = need(positional[0], 'usage: cairn comment <ref> "<text>"')
    const content = await resolveValue(need(positional[1], 'a comment body is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/comments`, { content }))
  },

  async attach() {
    const ref = need(positional[0], 'usage: cairn attach <ref> <file>')
    const file = need(positional[1], 'a file path is required')
    const size = statSync(file).size
    process.stderr.write(`uploading ${basename(file)} (${size} bytes, ${mimeOf(file)})\n`)
    emit(await upload(`/api/v1/tasks/${ref}/attachments`, file))
  },

  async files() {
    const ref = need(positional[0], 'usage: cairn files <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/attachments`)
    emit(data, {
      rows: (d) =>
        d.map((a) => ({
          id: a.id,
          name: a.original_name,
          type: a.mime_type,
          bytes: a.size_bytes,
          by: a.actor_id,
        })),
      columns: ['id', 'name', 'type', 'bytes', 'by'],
    })
  },

  async children() {
    const ref = need(positional[0], 'usage: cairn children <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/children`)
    emit(data.children, {
      rows: (d) => d.map((t) => ({ ref: t.ref, status: t.status, title: truncate(t.title, 62) })),
      columns: ['ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv') {
      process.stderr.write(
        data.count === 0 ? 'no sub-tasks\n' : `${data.closed}/${data.count} closed\n`,
      )
    }
  },

  async history() {
    const ref = need(positional[0], 'usage: cairn history <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/activity`)
    emit(data, {
      rows: (d) =>
        d.map((e) => ({
          when: e.created_at.slice(0, 16).replace('T', ' '),
          who: e.actor_id,
          event: e.event,
          detail: summariseEvent(e.data),
        })),
      columns: ['when', 'who', 'event', 'detail'],
    })
    if (FORMAT === 'tsv' && data.length === 0) process.stderr.write('no recorded activity\n')
  },

  async deps() {
    const ref = need(positional[0], 'usage: cairn deps <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/dependencies`)
    emit(data, {
      rows: (d) =>
        d.map((r) => ({
          direction: r.direction,
          ref: r.ref,
          status: r.status,
          title: truncate(r.title, 62),
        })),
      columns: ['direction', 'ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv' && data.length === 0) {
      process.stderr.write('no dependencies\n')
    }
  },

  async blockedby() {
    const ref = need(positional[0], 'usage: cairn blockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    emit(await request('POST', `/api/v1/tasks/${ref}/dependencies`, {
      ref: other,
      direction: 'blocked-by',
    }))
  },

  async unblockedby() {
    const ref = need(positional[0], 'usage: cairn unblockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    const q = new URLSearchParams({ ref: other, direction: 'blocked-by' })
    emit(await request('DELETE', `/api/v1/tasks/${ref}/dependencies?${q}`))
  },

  async labels() {
    const sub = positional[0]
    if (sub === 'rename' || sub === 'merge') {
      const from = need(positional[1], 'usage: cairn labels rename <from> <to>')
      const to = need(positional[2], 'a new label name is required')
      emit(await request('PATCH', '/api/v1/labels', { from, to }))
      return
    }
    if (sub === 'remove' || sub === 'delete') {
      const from = need(positional[1], 'usage: cairn labels remove <label>')
      emit(await request('PATCH', '/api/v1/labels', { from, to: null }))
      return
    }
    if (sub) die(`unknown subcommand "${sub}" — expected rename or remove`)

    const data = await request('GET', '/api/v1/labels')
    emit(data, {
      rows: (d) => d.map((l) => ({ label: l.label, tasks: l.task_count })),
      columns: ['label', 'tasks'],
    })
  },

  /**
   * Deleting a task, which almost nobody should be doing.
   *
   * `cancel` keeps the record and the reason and is what this store is for;
   * this is for junk that should never have existed. The server refuses a task
   * with children, notes, comments or dependants, and demands the ref back.
   */
  async task() {
    const sub = need(positional[0], 'usage: cairn task delete <ref> --confirm <ref>')
    if (sub !== 'delete') die(`unknown subcommand "${sub}" — expected delete`)
    const ref = need(positional[1], 'a task ref is required, e.g. CAI-42')

    // Ask before telling: the ref the server knows is canonical (a former
    // project key still resolves), and confirming with a spelling the server
    // will not echo back would fail for a reason nobody could see.
    const task = await request('GET', `/api/v1/tasks/${encodeURIComponent(ref)}`)
    const canonical = `${task.project.key}-${task.number}`

    if (flags.confirm !== canonical) {
      die(
        `This permanently deletes ${canonical} — "${task.title}" — and cannot be undone.\n` +
          `Cancelling keeps the record: cairn cancel ${canonical} --resolution "..."\n` +
          `Re-run with --confirm ${canonical} if deletion is really what you want.`,
      )
    }

    emit(
      await request(
        'DELETE',
        `/api/v1/tasks/${encodeURIComponent(canonical)}?confirm=${encodeURIComponent(canonical)}`,
      ),
    )
  },

  async project() {
    const sub = need(
      positional[0],
      'usage: cairn project <create|rename|rekey|archive|restore|delete> <KEY> [...]',
    )
    const key = need(positional[1], 'a project key is required')

    /**
     * Creating one, which this CLI could not do until now.
     *
     * The server has always accepted POST /api/v1/projects, so any agent that
     * went looking at the OpenAPI document could open a project while an agent
     * following the CLI concluded it was not allowed to. Two agents reading
     * the same system got different answers about what they may do, and that
     * asymmetry is what this closes — the capability was already there.
     */
    if (sub === 'create') {
      const title = need(positional[2], 'usage: cairn project create <KEY> "<title>"')
      // Checked here as well as on the server, so the error names the rule
      // rather than coming back as a validation failure from a POST.
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
        die(`"${key}" is not a project key — 2 to 10 uppercase letters or digits, e.g. CAIRN`)
      }
      const description = flags.body === undefined ? undefined : await resolveValue(flags.body)
      emit(
        await request('POST', '/api/v1/projects', {
          key,
          title,
          ...(description ? { description } : {}),
        }),
      )
      return
    }

    /**
     * Changing the KEY, which the API has always allowed and this CLI never
     * offered — so the one rename that rewrites every ref was the one only
     * reachable by a hand-written PATCH (CAIRN-264). `rekey` says what it does;
     * `rename --key` is the same thing in the spelling `entities rename` uses.
     */
    const rekey = async (newKey, title) => {
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(newKey)) {
        die(`"${newKey}" is not a project key — 2 to 10 uppercase letters or digits, e.g. CAIRN`)
      }
      const data = await request('PATCH', `/api/v1/projects/${key}`, {
        key: newKey,
        ...(title ? { title } : {}),
      })
      emit(data)
      if (FORMAT !== 'tsv') return
      if (!data.former_key) {
        process.stderr.write(`${data.key} already has that key; nothing changed.\n`)
        return
      }
      const was = data.former_key
      process.stderr.write(
        `renamed ${was} -> ${data.key}: every ${was}-n ref now reads ${data.key}-n.\n` +
          `${was}-n refs keep resolving, so commits and notes that say ${was}-42 still find ` +
          `${data.key}-42, and ${was} cannot be given to another project.\n` +
          `checkouts mapped to ${was} keep working; run "cairn map ${data.key}" in each to update the map.\n`,
      )
    }

    if (sub === 'rekey') {
      await rekey(need(positional[2], 'usage: cairn project rekey <KEY> <NEW_KEY>'))
      return
    }

    if (sub === 'rename') {
      if (flags.key !== undefined) {
        const newKey = need(flags.key, 'usage: cairn project rename <KEY> --key <NEW_KEY> ["<new title>"]')
        await rekey(newKey, positional[2])
        return
      }
      const title = need(positional[2], 'usage: cairn project rename <KEY> "<new title>"  (or --key <NEW_KEY>)')
      emit(await request('PATCH', `/api/v1/projects/${key}`, { title }))
      return
    }
    if (sub === 'archive' || sub === 'restore') {
      emit(await request('PATCH', `/api/v1/projects/${key}`, {
        status: sub === 'archive' ? 'archived' : 'active',
      }))
      return
    }
    if (sub === 'delete') {
      // Deleting a project removes every task in it. The API demands the key
      // back as confirmation; require it here too rather than passing it
      // silently on the caller's behalf.
      if (flags.confirm !== key) {
        const info = await request('GET', `/api/v1/projects/${key}`)
        die(
          `This would delete ${info.task_count} task(s) in ${key} and everything ` +
            `attached to them, permanently.\nRe-run with --confirm ${key} if that is what you want.`,
        )
      }
      emit(await request('DELETE', `/api/v1/projects/${key}?confirm=${encodeURIComponent(key)}`))
      return
    }
    die(`unknown subcommand "${sub}" — expected create, rename, rekey, archive, restore or delete`)
  },

  async claim() {
    const ref = need(positional[0], 'usage: cairn claim <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/claim`, {}))

    // What already bears on it, at the moment it is picked up (CAIRN-268). A
    // recall nobody remembers to run is one that does not happen, and the case
    // it exists for — a closure elsewhere saying "do not read this as
    // permission for <this task>" — is exactly the one the claimer does not
    // know to look for. stderr, and soft: the claim has already succeeded.
    if (FORMAT !== 'tsv') return
    const r = await request('GET', `/api/v1/tasks/${ref}/recall?decisions=3&knowledge=3`, undefined, { soft: true })
    const decisions = Array.isArray(r?.decisions) ? r.decisions : []
    const facts = Array.isArray(r?.knowledge) ? r.knowledge : []
    if (decisions.length === 0 && facts.length === 0) return
    const lines = [`bears on this — cairn recall ${ref}:`]
    for (const d of decisions) {
      lines.push(`  ${d.ref} ${d.kind} (${d.why.join(', ')}): ${truncate(d.text, 140)}`)
    }
    if (facts.length) lines.push(`  knowledge: ${facts.map((k) => k.slug + (factMark(k) ? ` [${factMark(k)}]` : '')).join(', ')}`)
    process.stderr.write(`${lines.join('\n')}\n`)
  },
  async beat() {
    emit(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: cairn beat <ref>')}/beat`, {}))
  },
  /**
   * `--force` releases a claim another session holds. The server refuses that
   * by default, because releasing somebody else's claim used to be silent and
   * indistinguishable from releasing your own.
   */
  async release() {
    const ref = need(positional[0], 'usage: cairn release <ref> [--force]')
    emit(await request('POST', `/api/v1/tasks/${ref}/release`, { force: Boolean(flags.force) }))
  },
  async checkpoint() {
    const ref = need(positional[0], 'usage: cairn checkpoint <ref> --summary "<state>"')
    const summary = await resolveValue(need(flags.summary, 'a --summary is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/checkpoint`, { summary }))
  },
  async block() {
    const ref = need(positional[0], 'usage: cairn block <ref> --reason "<why>"')
    const reason = await resolveValue(need(flags.reason, 'a --reason is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason }))
  },
  async unblock() {
    const ref = need(positional[0], 'usage: cairn unblock <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason: null }))
  },

  // --- knowledge ---------------------------------------------------------

  async learn() {
    const title = need(positional[0], 'usage: cairn learn "<title>" --body -')
    const body = await resolveValue(flags.body ?? '')
    // A bare title reads in every list exactly like a fact with an
    // explanation behind it. The server refuses it too (CAIRN-289); saying so
    // here saves the round trip and names the flag.
    if (!String(body).trim()) {
      die('a fact needs a body: what it means and how it was found.\n' +
        '  cairn learn "<title>" --body -   # markdown on stdin')
    }
    /**
     * Scope is decided before the write, not regretted after it.
     *
     * This used to default to global whenever --project was absent, and warn
     * afterwards. Measured over the store, the import scoped 8% of its facts
     * global while everything written here since ran at 27% — three times
     * worse, which is what a silent default to the widest scope predicts. A
     * misfiled task is a nuisance in one place; a fact filed global is in
     * front of every project, permanently.
     *
     * So: an explicit scope wins, a mapped directory supplies one when none
     * is given, and global has to be asked for. `cairn add` has always
     * refused to file a task without a project; this is the same rule for the
     * half that travels further.
     */
    const chosen = splitList(flags.project)
    const entities = flags.entity ? splitList(flags.entity) : []

    // Only when nothing was chosen, so the common path costs nothing extra.
    // The local map answers most of the time; the git remote answers where it
    // cannot — a second clone, a worktree, a directory nobody ran `cairn map`
    // in — and only the server can turn a remote into a project, so it is
    // asked. This is the same resolution `cairn context` performs, and the
    // same principle as resolving a task's project from the repository rather
    // than the path (CAIRN-123).
    let here = null
    if (!chosen.length && !entities.length && !flags.global) {
      const cwd = process.cwd()
      here = projectForDir(cwd)
      if (!here) {
        const remote = gitRemote(cwd)
        if (remote) {
          const params = new URLSearchParams({ cwd, repo: remote })
          const seen = await request('GET', `/api/v1/context?${params}`, undefined, { soft: true })
          here = seen?.project ?? null
        }
      }
    }

    if (!chosen.length && !entities.length && !flags.global && !here) {
      die(
        'scope this fact before filing it:\n' +
          '  --project <KEY>   true of one codebase\n' +
          '  --entity <key>    true of a business or a stack (cairn entities)\n' +
          '  --global          true everywhere — say so on purpose\n' +
          'This directory maps to no project, so there is nothing to infer from.',
      )
    }

    const projects = chosen.length ? chosen : here ? [here] : []

    const payload = {
      title,
      body,
      labels: splitList(flags.label),
      projects,
    }
    if (entities.length) payload.entities = entities
    if (flags.slug) payload.slug = flags.slug
    if (flags.task) payload.sourceTaskRef = flags.task
    // Files it is about beyond the paths its body names (CAIRN-269).
    if (flags.files) payload.files = splitList(flags.files)
    if (flags.verified) payload.verified = true
    // The write refuses a [[reference]] whose fact the store already holds
    // under another slug, and names it. That refusal is the point, so this
    // exists for the case it gets wrong — a genuinely new fact whose name
    // happens to resemble an existing one — and not as the easy way past it.
    if (flags['allow-dangling']) payload.allowUnresolvedRefs = true

    const result = await request('POST', '/api/v1/knowledge', payload)
    emit(result)

    // A reference that resolved to nothing close is accepted, because two
    // entries citing each other cannot both be written first. Accepted is not
    // the same as unremarkable, so it is said — on stderr, where a warning
    // belongs, rather than in the row a caller parses.
    for (const warning of result?.warnings ?? []) {
      process.stderr.write(`cairn: ${warning}\n`)
    }

    // Same-topic entries already in the store. A new fact that contradicts
    // an old one leaves both reading as true unless somebody links them.
    if (result?.similar?.length) {
      process.stderr.write('cairn: existing entries on the same subject:\n')
      for (const k of result.similar) process.stderr.write(`  ${k.slug}  (${k.scope})  ${truncate(k.title, 70)}\n`)
      process.stderr.write(
        `  if one is now wrong: cairn unlearn <slug> --superseded-by ${result.slug}` +
          ' — or cairn relearn it; if they agree, link them with [[slug]]\n',
      )
    }
    if (FORMAT === 'tsv' && result?.source_task_id && !flags.task) {
      process.stderr.write('linked to the task this session holds — --task <ref> to name another\n')
    }

    // Say what was inferred. Silent correctness is still a surprise the next
    // time someone expects the old behaviour.
    if (FORMAT === 'tsv' && here) {
      process.stderr.write(`scoped to ${here} — this directory's project. --global if it is true everywhere\n`)
    }
  },

  async know() {
    const subject = positional[0]

    /**
     * Where the memory has holes.
     *
     * The map that found these is a web page, and everything that writes
     * knowledge here is an agent. Without this the findings were visible only
     * to whoever happened to open a browser -- observations rather than
     * something anybody could act on.
     */
    if (flags.orphans || flags.dangling || flags.gaps) {
      const gaps = await request('GET', '/api/v1/knowledge/gaps')
      if (FORMAT === 'json') return emit(gaps)

      const { stats } = gaps
      if (flags.dangling) {
        emit(
          { count: gaps.missing.length, results: gaps.missing },
          {
            rows: (d) =>
              d.results.map((m) => ({
                slug: m.slug,
                refs: String(m.from.length),
                'referenced by': m.from.slice(0, 3).join(', ') + (m.from.length > 3 ? ' …' : ''),
              })),
            columns: ['slug', 'refs', 'referenced by'],
          },
        )
        if (FORMAT === 'tsv' && gaps.missing.length > 0) {
          process.stderr.write(
            `${stats.dangling} reference${stats.dangling === 1 ? '' : 's'} point at ` +
              `${gaps.missing.length} entr${gaps.missing.length === 1 ? 'y' : 'ies'} that ` +
              `do not exist. Write one, or correct the entry that points at it.\n`,
          )
        }
        return
      }

      if (flags.orphans) {
        emit(
          { count: gaps.orphans.length, results: gaps.orphans },
          {
            rows: (d) =>
              d.results.map((o) => ({
                slug: o.slug,
                scope: o.project ?? 'global',
                title: truncate(o.title, 70),
              })),
            columns: ['slug', 'scope', 'title'],
          },
        )
        if (FORMAT === 'tsv' && gaps.orphans.length > 0) {
          process.stderr.write(
            `${stats.isolated} of ${stats.entries} entries reference nothing and are ` +
              `referenced by nothing. A fact nothing points at is one nobody finds by ` +
              `following a trail.\n`,
          )
        }
        return
      }

      process.stdout.write(
        `${stats.entries} entries, ${stats.resolved} resolving references\n` +
          `${stats.islands} island${stats.islands === 1 ? '' : 's'}` +
          (gaps.islands.length ? `, largest holds ${gaps.islands[0]}` : '') +
          `\n${stats.isolated} joined to nothing  (cairn know --orphans)\n` +
          `${gaps.missing.length} referenced but never written  (cairn know --dangling)\n`,
      )
      return
    }

    // A bare word that is a slug we hold is a fetch; anything else is a search.
    // Agents should not have to know which, and the distinction is cheap to make.
    //
    // Underscores are accepted because the store is full of `[[a_b_c]]`
    // references that mean `a-b-c` — they arrived with the claude-mem import.
    // While this shape rejected them, following one's own reference fell
    // through to full-text search, which on a real pair returned five loosely
    // related entries and not the target, with nothing to say it had missed.
    // The server normalises the spelling on lookup; this only has to stop
    // ruling the reference out before asking.
    /**
     * Facts nobody was given in a month (CAIRN-270): dead, or titled so that
     * no search finds them. Either way worth a look — link it, retitle it,
     * verify it, or unlearn it. The count leaves out the session briefing,
     * which records nothing, and the output says so.
     */
    if (flags.unused) {
      const days = flags.days ?? (flags.unused === true ? '30' : flags.unused)
      const params = new URLSearchParams({ unused: String(days), limit: flags.limit ?? '50' })
      const data = await request('GET', `/api/v1/knowledge?${params}`)
      if (FORMAT === 'json') return emit(data)
      emit(data, {
        rows: (d) =>
          d.results.map((u) => ({
            slug: u.slug,
            'last recalled': u.lastRecalled ? u.lastRecalled.slice(0, 10) : 'never',
            written: u.createdAt.slice(0, 10),
            title: truncate(u.title, 60),
          })),
        columns: ['slug', 'last recalled', 'written', 'title'],
      })
      if (FORMAT === 'tsv') {
        process.stderr.write(`not recalled in ${data.days} days — ${data.counted}\n`)
        // An empty list because the store is younger than the window is "not
        // yet", and printing only the zero reads as "everything is used".
        if (data.note) process.stderr.write(`cairn: ${data.note}\n`)
      }
      return
    }

    /**
     * What it used to say (CAIRN-266). One row per version, newest first, each
     * saying how it came to be: written, or which edit produced it, by whom and
     * why. `--full` prints the bodies, which is the part worth comparing.
     */
    if (flags.history) {
      const slug = need(subject, 'usage: cairn know <slug> --history [--full]')
      const h = await request('GET', `/api/v1/knowledge/${slug}/history`)
      if (FORMAT === 'json') return emit(h)

      const versions = [
        {
          version: `${h.version} (live)`,
          change: h.revisions[0]?.change ?? 'learned',
          by: h.revisions[0]?.edited_by ?? h.author ?? '',
          at: (h.revisions[0]?.edited_at ?? h.createdAt ?? '').slice(0, 16).replace('T', ' '),
          reason: h.revisions[0]?.reason ?? '',
          title: h.title,
        },
        ...h.revisions.map((r, i) => {
          const older = h.revisions[i + 1]
          return {
            version: String(r.revision),
            change: older?.change ?? 'learned',
            by: older?.edited_by ?? (r.revision === 1 ? h.author ?? '' : ''),
            at: (older?.edited_at ?? (r.revision === 1 ? h.createdAt : '') ?? '').slice(0, 16).replace('T', ' '),
            reason: older?.reason ?? '',
            title: r.title,
          }
        }),
      ]

      if (flags.full) {
        const bodies = [{ revision: h.version, body: null }, ...h.revisions]
        for (const [i, v] of versions.entries()) {
          process.stdout.write(`## v${v.version} · ${v.change} · ${v.by} · ${v.at}\n`)
          if (v.reason) process.stdout.write(`reason: ${v.reason}\n`)
          process.stdout.write(`# ${v.title}\n\n`)
          if (i > 0) process.stdout.write(`${bodies[i].body}\n\n`)
          else process.stdout.write('(the live body — cairn know ' + h.slug + ')\n\n')
        }
        return
      }

      emit(
        { count: versions.length, results: versions },
        {
          rows: (d) => d.results.map((v) => ({ ...v, reason: truncate(v.reason, 50), title: truncate(v.title, 60) })),
          columns: ['version', 'change', 'by', 'at', 'reason', 'title'],
        },
      )
      if (FORMAT === 'tsv' && h.revisions.length === 0) {
        process.stderr.write('never revised: this is the version first written\n')
      }
      return
    }

    if (subject && /^[a-z0-9]+([_-][a-z0-9]+)*$/i.test(subject)) {
      const hit = await request('GET', `/api/v1/knowledge/${subject}`, undefined, { soft: true })
      if (hit) {
        if (FORMAT === 'json') return emit(hit)
        const k = hit
        process.stdout.write(`# ${k.title}\n`)
        if (k.labels?.length) process.stdout.write(`labels: ${k.labels.join(', ')}\n`)
        // Both scopes, or this reports a fact scoped to an entity as true
        // everywhere — which is the opposite of what it says.
        const scope = k.projects?.length
          ? k.projects.join(', ')
          : k.entities?.length
            ? k.entities.join(', ')
            : 'global'
        process.stdout.write(`scope: ${scope}\n\n`)
        process.stdout.write(`${k.body}\n`)

        /**
         * Which of this entry's own references point at nothing.
         *
         * The browser marks these where they are rendered; here the body is
         * printed verbatim, so an agent following `[[a-slug]]` could not tell
         * a live reference from a dead one and would fall through to a search
         * that quietly misses. Asked for only when the body actually contains
         * a reference, so the ordinary read stays one request.
         */
        const referenced = [
          ...new Set(
            [...k.body.matchAll(/\[\[([A-Za-z0-9][A-Za-z0-9_-]{1,118}[A-Za-z0-9])\]\]/g)].map(
              (m) => m[1].trim().toLowerCase().replace(/_/g, '-'),
            ),
          ),
        ]
        if (referenced.length > 0) {
          const gaps = await request('GET', '/api/v1/knowledge/gaps', undefined, { soft: true })
          const unwritten = new Set((gaps?.missing ?? []).map((m) => m.slug))
          const dead = referenced.filter((r) => unwritten.has(r))
          if (dead.length > 0) {
            process.stderr.write(
              `\nreferences nothing has written: ${dead.join(', ')}\n` +
                `Write one, or correct this entry — a reference that resolves to nothing ` +
                `reads as a trail and ends in a search.\n`,
            )
          }
        }
        return
      }
    }

    const params = new URLSearchParams()
    // Set before the search branch returns, not after it. Living below that
    // early return, --project was accepted and silently dropped on every
    // `cairn know "<query>" --project K` — the CAIRN-145 failure exactly,
    // relocated from the SQL into the CLI, on the verb agents use most. The
    // server honours the parameter; only this dropped it.
    if (flags.project) params.set('project', flags.project)
    if (flags.label) params.set('label', flags.label)
    if (flags.limit) params.set('limit', flags.limit)
    if (flags.superseded) params.set('superseded', '1')

    if (subject) {
      params.set('q', subject)
      params.set('kinds', 'knowledge')
      const data = await request('GET', `/api/v1/search?${params}`)
      return emit(data, {
        rows: (d) => d.results.map((r) => ({
          slug: r.ref,
          scope: r.project ?? 'global',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
        columns: ['slug', 'scope', 'tokens', 'title'],
      })
    }

    const data = await request('GET', `/api/v1/knowledge?${params}`)
    emit(data, {
      rows: (d) => d.results.map((r) => ({
        slug: r.slug,
        // Where it applies, narrowest first: this project, else the groupings
        // it belongs to, else everywhere.
        scope: r.projects?.length
          ? r.projects.join(',')
          : r.entities?.length
            ? r.entities.join(',')
            : 'global',
        verified: r.verified ? 'yes' : '',
        // Searches that returned it and direct reads, last 30 days (CAIRN-270).
        recalled: String(r.recalled ?? ''),
        tokens: `~${r.tokens}`,
        title: truncate(r.title, 70),
      })),
      // `recalled` last: a column appended at the end is one no reader of this
      // table sees move.
      columns: ['slug', 'scope', 'verified', 'tokens', 'title', 'recalled'],
    })
  },

  async unlearn() {
    const slug = need(positional[0], 'usage: cairn unlearn <slug> [--superseded-by <slug>]')
    if (flags['superseded-by']) {
      return emit(await request('PATCH', `/api/v1/knowledge/${slug}`, {
        supersededBy: flags['superseded-by'],
        ...(typeof flags.reason === 'string' ? { reason: flags.reason } : {}),
      }))
    }
    emit(await request('DELETE', `/api/v1/knowledge/${slug}`))
  },

  /**
   * Confirm a fact is still true, without rewriting it.
   *
   * The correction path already existed (`relearn`); the confirmation path did
   * not, so the only way to clear a stale mark was to restate the whole body.
   * Marking something stale and offering no cheap way to answer is how a
   * confidence signal becomes noise everyone learns to scroll past.
   */
  async verify() {
    const slug = need(positional[0], 'usage: cairn verify <slug>')
    emit(await request('PATCH', `/api/v1/knowledge/${slug}`, { verified: true }))
  },

  /**
   * Send whatever was put aside while the server was unreachable.
   *
   * Rarely needed by hand — any successful write drains the queue — but a
   * queue with no way to look at it is a queue nobody trusts.
   */
  async replay() {
    const result = await flushOutbox()
    emit(result, {
      lines: (d) =>
        d.sent + d.rejected + d.left === 0
          ? ['nothing queued']
          : [
              `sent ${d.sent}, rejected ${d.rejected}, still queued ${d.left}` +
                (d.waiting ? ` (${d.waiting} for another runtime or instance)` : ''),
            ],
    })
  },

  async relearn() {
    const slug = need(positional[0], 'usage: cairn relearn <slug> [--body -] [--title T]')
    const patch = {}
    if (flags.body !== undefined) patch.body = await resolveValue(flags.body)
    if (flags.title) patch.title = flags.title
    if (flags.label) patch.labels = splitList(flags.label)
    // A PATCH only touches the side it is given, so `--entity X` adds an entity
    // and leaves the project in place — and moving a fact from a project to an
    // entity needed a way to clear one side. `none` is that way, as for `cairn
    // map none`. An empty value used to be read as "not given" and silently
    // dropped, the CAIRN-262 failure again; it is refused instead (CAIRN-295).
    const scopeList = (name) => {
      const raw = flags[name]
      if (raw === undefined) return undefined
      if (raw === true || splitList(raw).length === 0) {
        die(`--${name} needs a value: a key, a comma list, or none to clear it`)
      }
      const list = splitList(raw)
      return list.length === 1 && list[0].toLowerCase() === 'none' ? [] : list
    }
    const projects = scopeList('project')
    const entities = scopeList('entity')
    if (projects) patch.projects = projects
    if (entities) patch.entities = entities
    // `--global` on a PATCH has to CLEAR, where on `learn` it only means "do
    // not infer from this directory". Both scopes go: a fact true everywhere
    // is one with no project and no entity, and clearing only projects would
    // leave `relearn --global` producing a state `learn --global` cannot.
    //
    // It was missing entirely and, because KNOWN_FLAGS is one list for every
    // verb, `cairn relearn <slug> --global` parsed, printed the entry with its
    // old scope still on it, and exited 0 (CAIRN-262).
    if (flags.global) {
      if (projects !== undefined || entities !== undefined) {
        die('--global means no project and no entity; do not pass it with --project or --entity')
      }
      patch.projects = []
      patch.entities = []
    }
    if (flags.verified) patch.verified = true
    // PATCH runs the same [[reference]] check as the write, so relearn needs
    // the same way past it. Without this the flag parses — it is in the global
    // KNOWN_FLAGS — and is silently dropped, which is the exact thing that set
    // refuses to do: an answer that looks like it took your argument and did
    // not.
    if (flags['allow-dangling']) patch.allowUnresolvedRefs = true
    // Why it changed, kept on the version this replaces (CAIRN-266).
    if (typeof flags.reason === 'string') patch.reason = flags.reason
    // Replaces the explicitly named files; `--files ''` clears them (CAIRN-269).
    if (flags.files !== undefined) patch.files = flags.files === true ? [] : splitList(flags.files)

    const result = await request('PATCH', `/api/v1/knowledge/${slug}`, patch)
    emit(result)
    for (const warning of result?.warnings ?? []) {
      process.stderr.write(`cairn: ${warning}\n`)
    }
  },

  async entities() {
    const verb = positional.shift()

    if (verb === 'add') {
      const key = need(positional[0], 'usage: cairn entities add <key> "<title>" [--project A,B]')
      return emit(
        await request('POST', '/api/v1/entities', {
          key,
          title: positional[1] ?? key,
          description: flags.description ?? '',
          projects: splitList(flags.project),
        }),
      )
    }

    if (verb === 'rename') {
      const key = need(positional[0], 'usage: cairn entities rename <key> [--key <new>] [--title "T"]')
      const patch = { key }
      if (flags.key) patch.newKey = flags.key
      if (flags.title) patch.title = flags.title
      if (flags.description) patch.description = flags.description
      return emit(await request('PATCH', '/api/v1/entities', patch))
    }

    if (verb === 'assign' || verb === 'unassign') {
      const key = need(positional[0], `usage: cairn entities ${verb} <key> --project A,B`)
      const projects = splitList(flags.project ?? positional[1])
      if (projects.length === 0) die('--project is required')
      return emit(
        await request('PATCH', '/api/v1/entities', {
          key,
          addProjects: verb === 'assign' ? projects : [],
          removeProjects: verb === 'unassign' ? projects : [],
        }),
      )
    }

    if (verb) die(`unknown entities verb "${verb}" — try: add, rename, assign, unassign`)

    const data = await request('GET', '/api/v1/entities')
    emit(data, {
      rows: (d) =>
        d.results.map((e) => ({
          entity: e.key,
          projects: e.projects.length,
          keys: truncate(e.projects.join(' '), 58),
          title: e.title,
        })),
      columns: ['entity', 'projects', 'keys', 'title'],
    })
  },

  /**
   * What to pick up, rather than what exists.
   *
   * The briefing says what is held, in flight and dropped, and never which one
   * to do — so every agent invented its own ranking and they disagreed. The
   * reason is printed with the pick because a recommendation nobody can check
   * is one nobody should follow.
   */
  async next() {
    const params = new URLSearchParams()
    const project = flags.project ?? projectForDir(process.cwd())
    if (project) params.set('project', project)
    const data = await request('GET', `/api/v1/next?${params}`)

    if (FORMAT === 'json') return emit(data)
    if (!data.pick) {
      const why = data.considered
        ? `nothing workable — ${data.considered} open, all blocked, waiting on something, or held by someone else`
        : 'nothing open'
      process.stdout.write(`${why}\n`)
      return
    }

    const line = (t) => `${t.ref}  ${t.title}`
    process.stdout.write(
      `${line(data.pick)}\n  ${data.pick.reason}\n  ${data.pick.priority} · ${data.pick.status}` +
        `\n\n  cairn claim ${data.pick.ref}\n` +
        (data.then?.length
          ? `\nthen:\n${data.then.map((t) => `  ${line(t)}`).join('\n')}\n`
          : ''),
    )
  },

  // --- the briefing ------------------------------------------------------

  /**
   * What already bears on one task (CAIRN-268): decisions on the tasks around
   * it and the knowledge that applies, each line saying why it was picked. Run
   * it when picking a task up — it is the question `check` answers from a
   * phrase, asked from the task instead.
   */
  async recall() {
    const ref = need(positional[0], 'usage: cairn recall <ref> [--limit N]')
    const params = new URLSearchParams()
    if (flags.limit) {
      params.set('decisions', flags.limit)
      params.set('knowledge', flags.limit)
    }
    const r = await request('GET', `/api/v1/tasks/${ref}/recall${String(params) ? `?${params}` : ''}`)
    if (FORMAT !== 'tsv') return emit(r)

    const out = [`# ${r.ref} — ${r.title}`, '']
    out.push(r.decisions.length ? 'decisions' : 'decisions: none recorded on related tasks')
    for (const d of r.decisions) {
      out.push(`  ${d.ref}  ${d.kind} · ${d.why.join(', ')} · ${d.by ?? '?'} · ${d.at.slice(0, 10)}  [${d.status}]`)
      out.push(`    ${d.text}`)
    }
    out.push('')
    out.push(r.knowledge.length ? 'knowledge' : 'knowledge: nothing linked or matching')
    for (const k of r.knowledge) {
      const marks = [factMark(k), k.verified ? 'verified' : ''].filter(Boolean).join(', ')
      out.push(`  ${k.slug}${marks ? `  [${marks}]` : ''}`)
      out.push(`    ${k.title} — ${k.why.join('; ')}`)
    }
    const more = []
    if (r.omitted.decisions) more.push(`${r.omitted.decisions} more decision(s)`)
    if (r.omitted.knowledge) more.push(`${r.omitted.knowledge} more fact(s)`)
    if (more.length) out.push('', `${more.join(', ')} — cairn recall ${ref} --limit 30`)
    process.stdout.write(`${out.join('\n')}\n`)
  },

  async context() {
    const cwd = flags.cwd ?? process.cwd()
    const params = new URLSearchParams()
    params.set('cwd', cwd)
    const project = flags.project ?? projectForDir(cwd)
    if (project) params.set('project', project)
    if (flags.scope !== undefined) {
      if (flags.scope !== 'project' && flags.scope !== 'all') die('--scope must be project or all')
      params.set('scope', flags.scope)
    }
    // Costs one local git call and answers where the map cannot: a second
    // clone, a moved directory, a worktree.
    const repo = gitRemote(cwd)
    if (repo) params.set('repo', repo)
    if (flags.file) params.set('file', flags.file)
    const data = await request('GET', `/api/v1/context?${params}`)
    if (FORMAT === 'json') return emit(data)
    process.stdout.write(renderContext(data, { fileOnly: Boolean(flags.file) }))
  },

  /**
   * Which instance a directory belongs to, and saving the answer. Local only,
   * like `instance`: the point is to be usable exactly when nothing is routed.
   *
   * Saving an answer also sends the sessions the session-end hook parked while
   * nobody had said where they go — the reason parking loses nothing.
   */
  async route() {
    const sub = positional[0] ?? 'show'
    if (!INSTANCES) die('this machine has one instance (no ~/.cairn/instances.json); there is nothing to route', 2)
    if (INSTANCES.error) die(`cairn: ${INSTANCES.error}`, 2)
    const dir = flags.dir ? realDir(String(flags.dir)) : ROUTE_DIR
    const { key, repo } = routeKey(dir)

    if (sub === 'show') {
      return emit(INSTANCE.name
        ? { path: tilde(key), instance: INSTANCE.name, why: INSTANCE.why }
        : { path: tilde(key), instance: null, why: INSTANCE.error ?? 'nothing routes it', waiting: parkedSessions().filter((p) => p.cwd && routeKey(p.cwd).key === key).length })
    }
    if (sub === 'list') {
      return emit(INSTANCES.routes.map((r) => ({ path: tilde(r.path), match: r.match, instance: r.instance })))
    }
    if (sub === 'pending') {
      return emit(parkedSessions().map((p) => ({
        session: p.sessionId, t: p.t, cwd: p.cwd ? tilde(p.cwd) : undefined, agent: p.agent ?? undefined,
        routes_to: p.cwd ? resolveRoute({ config: INSTANCES, dir: p.cwd, session: p.sessionId }).name ?? undefined : undefined,
      })))
    }
    if (sub === 'remove') {
      const match = flags.folder ? 'folder' : 'exact'
      const routes = INSTANCES.routes.filter((r) => !(r.match === match && r.path === key))
      if (routes.length === INSTANCES.routes.length) die(`no ${match} route for ${tilde(key)}`)
      writeInstancesConfig({ ...INSTANCES.raw, version: 1, routes })
      return emit({ removed: tilde(key), match })
    }
    if (sub !== 'add') die('usage: cairn route [show|list|pending|add <instance> [--folder|--session] [--dir D] [--force]|remove [--folder] [--dir D]]')

    const instance = need(positional[1], 'usage: cairn route add <instance> [--folder | --session] [--dir <path>] [--force]')
    if (flags.folder && flags.session) die('--folder and --session are different answers; give one')
    if (flags.session && !ROUTE_SESSION) die('--session needs a session id (CAIRN_SESSION_ID), and this shell has none')
    const config = { ...INSTANCES.raw, version: 1, instances: INSTANCES.instances, unclassified: INSTANCES.unclassified, routes: INSTANCES.routes, raw: INSTANCES.raw }
    const problem = saveRoute(config, {
      instance,
      key,
      folder: Boolean(flags.folder),
      session: flags.session ? ROUTE_SESSION : null,
      force: Boolean(flags.force),
    })
    if (problem) die(`cairn: ${problem}`, 2)

    // Replayed through this same CLI, one process per session, so each goes
    // through the routing just saved exactly as a live command would. Never
    // checkpointing: a parked session may be days old, and its held tasks
    // have moved on since.
    const after = readInstances()
    const sent = []
    const failed = []
    for (const parked of parkedSessions()) {
      const target = parked.cwd && resolveRoute({ config: after, dir: parked.cwd, session: parked.sessionId }).name
      if (!target || !Array.isArray(parked.args)) continue
      const args = parked.args.includes('--no-checkpoint') ? parked.args : [...parked.args, '--no-checkpoint']
      // The instance decides the server and the key; a CAIRN_API_KEY left in
      // this shell would only get every replay refused.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CAIRN_API_KEY', 'CAIRN_BASE_URL', 'CAIRN_INSTANCE'].includes(k)))
      const result = spawnSync(process.execPath, [process.argv[1], ...args, '--instance', target], {
        env: { ...env, CAIRN_AGENT: parked.agent ?? '', CAIRN_PLATFORM: parked.platform ?? '' },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (result.status === 0) {
        rmSync(parked.file, { force: true })
        sent.push(parked.sessionId)
      } else failed.push({ session: parked.sessionId, why: (result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n')[0] })
    }
    const scope = flags.session ? 'this session' : flags.folder ? `${tilde(key)} and everything under it` : `${repo ? 'repository' : 'directory'} ${tilde(key)}`
    return emit({ instance, scope, sent: sent.length, failed }, {
      lines: (d) => [
        `${d.scope} -> ${d.instance}`,
        ...(d.sent ? [`  sent ${d.sent} session(s) that were waiting for this`] : []),
        ...(d.failed.length
          ? [`  ${d.failed.length} waiting session(s) could not be sent yet (\`cairn route pending\` lists them); first: ${d.failed[0].why}`]
          : []),
      ],
    })
  },

  /**
   * Which instance this command would use, every instance configured, or one
   * more. Local only: none of these reads a key or contacts a server, so they
   * work on a machine whose configuration is exactly what needs looking at.
   */
  async instance() {
    const sub = positional[0] ?? 'show'
    if (sub === 'show') {
      if (INSTANCES?.error) die(`cairn: ${INSTANCES.error}`, 2)
      const shown = INSTANCE.name
        ? { instance: INSTANCE.name, why: INSTANCE.why, url: BASE, state: STATE_LABEL }
        : INSTANCES
          ? { instance: null, reason: INSTANCE.error ?? 'none chosen for this command' }
          : { instance: null, reason: 'this machine has one instance (no ~/.cairn/instances.json)', url: BASE, state: STATE_LABEL }
      return emit(shown)
    }
    if (sub === 'list') {
      if (!INSTANCES) return emit([], { lines: () => ['one instance (no ~/.cairn/instances.json)'] })
      if (INSTANCES.error) die(`cairn: ${INSTANCES.error}`, 2)
      return emit(Object.entries(INSTANCES.instances).map(([name, { url }]) => ({
        instance: name,
        url,
        default: INSTANCES.unclassified.mode === 'default' && INSTANCES.unclassified.instance === name ? 'yes' : undefined,
        keys: existsSync(join(CAIRN_DIR, 'instances', name, 'env'))
          ? Object.keys(fileEnv(join(CAIRN_DIR, 'instances', name, 'env'))).filter((k) => k.startsWith('CAIRN_API_KEY')).length
          : 0,
      })))
    }
    if (sub !== 'add') die('usage: cairn instance [show|list|add <name> --url <url> [--default] [--adopt]]')

    const name = need(positional[1], 'usage: cairn instance add <name> --url <url> [--default] [--adopt]')
    if (!INSTANCE_NAME.test(name)) die(`"${name}" is not an instance name: lowercase letters, digits and dashes, up to 32`)
    const url = trimUrl(need(flags.url, 'cairn instance add needs --url <the server this instance is>'))
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error()
    } catch {
      die(`--url ${url} is not an http(s) URL`)
    }
    if (INSTANCES?.error) die(`cairn: ${INSTANCES.error} — fix it before adding to it`, 2)
    const config = INSTANCES
      ? { version: 1, instances: { ...INSTANCES.instances }, unclassified: INSTANCES.unclassified }
      : { version: 1, instances: {}, unclassified: { mode: 'ask' } }
    const existing = config.instances[name]
    if (existing && trimUrl(existing.url) !== url) {
      die(`instance "${name}" already points at ${existing.url}; edit ~/.cairn/instances.json to change it on purpose`)
    }
    config.instances[name] = { url }
    if (flags.default) config.unclassified = { mode: 'default', instance: name }

    const dir = join(CAIRN_DIR, 'instances', name)
    const legacy = ['env', 'projects.json', 'ownership'].filter((f) => existsSync(join(CAIRN_DIR, f)))
    const queued = existsSync(CAIRN_DIR) && readdirSync(CAIRN_DIR).some((f) =>
      (f === 'outbox.jsonl' || f.startsWith(OUTBOX_PREFIX)) && f !== basename(OUTBOX_LOCK_PATH))
    const moved = []
    if (flags.adopt && (legacy.length || queued)) {
      // The files at the top of ~/.cairn belong to the server they were used
      // with, found the way it always was: the environment, then ~/.cairn/env,
      // then localhost. Moving them under a different one would hand one
      // instance's keys, map and queued writes to another.
      const legacyUrl = trimUrl(
        process.env.CAIRN_BASE_URL || fileEnv(join(CAIRN_DIR, 'env')).CAIRN_BASE_URL || 'http://localhost:3000',
      )
      if (legacyUrl !== url) {
        die(`this machine's existing setup points at ${legacyUrl}, not ${url}: ` +
          '--adopt would move its keys to the wrong instance')
      }
      for (const file of legacy) {
        if (existsSync(join(dir, file))) die(`~/.cairn/instances/${name}/${file} already exists; not overwriting it`)
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (flags.adopt) {
      for (const file of legacy) {
        renameSync(join(CAIRN_DIR, file), join(dir, file))
        moved.push(file)
      }
      // Under the queue's own lock, so a write being queued right now lands
      // either before the move or in the next process's instance directory.
      // Appended rather than renamed onto a file already there: an adoption
      // interrupted halfway is finished by running it again, and a rename
      // would replace the queued writes it had already moved.
      await withOutboxLock(() => {
        for (const file of readdirSync(CAIRN_DIR)) {
          if (file !== 'outbox.jsonl' && !file.startsWith(OUTBOX_PREFIX)) continue
          if (file === basename(OUTBOX_LOCK_PATH)) continue
          const from = join(CAIRN_DIR, file)
          const to = join(dir, file)
          if (existsSync(to)) {
            appendFileSync(to, readFileSync(from), { mode: 0o600 })
            unlinkSync(from)
          } else renameSync(from, to)
          moved.push(file)
        }
      })
    }
    const temp = `${INSTANCES_PATH}.tmp`
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, INSTANCES_PATH)

    const notes = []
    if (moved.length) notes.push(`moved ${moved.join(', ')} into ~/.cairn/instances/${name}/`)
    else if (legacy.includes('env') && !INSTANCES && !flags.adopt) {
      notes.push('~/.cairn/env is no longer read now that instances are configured; ' +
        'its keys belong in the instance they were issued by (or re-run with --adopt)')
    }
    if (!existsSync(join(dir, 'env'))) {
      notes.push(`put this instance's keys in ~/.cairn/instances/${name}/env (CAIRN_API_KEY_<RUNTIME>=..., mode 600)`)
    }
    if (config.unclassified.mode === 'ask') notes.push('commands with no instance chosen stop and ask (exit 10)')
    return emit({ instance: name, url, default: flags.default ? 'yes' : undefined, notes }, {
      lines: (d) => [`instance ${d.instance} -> ${d.url}${d.default ? ' (default)' : ''}`, ...d.notes.map((n) => `  ${n}`)],
    })
  },

  async map() {
    const dir = flags.dir ?? gitRoot(process.cwd()) ?? process.cwd()
    const key = positional[0]

    if (!key) {
      const map = readProjectMap()
      const rows = Object.entries(map).map(([path, k]) => ({ project: k, path }))
      emit(
        { count: rows.length, here: projectForDir(process.cwd()) ?? '', rows },
        { rows: (d) => d.rows, columns: ['project', 'path'] },
      )
      await warnRetiredMappings(map)
      return
    }

    const map = readProjectMap()
    const repo = gitRemote(dir)
    let claimed = null

    if (key === 'none') {
      // Releasing the repository claim too, because `map <KEY>` made one.
      // Deleting only the local line left every clone of this repository —
      // including this one — still resolving, so `map none` reported success
      // and changed nothing observable: the silent failure this command was
      // just taught to stop producing.
      //
      // The claim belongs to a project, so we need the one that holds it: the
      // local line if there is one, and otherwise whatever the repository
      // itself currently resolves to, which is the case a fresh clone hits.
      const holder =
        map[dir] ??
        (repo
          ? (await request('GET', `/api/v1/context?repo=${encodeURIComponent(repo)}`, undefined, {
              soft: true,
            }))?.project
          : null)

      delete map[dir]

      if (repo && holder) {
        const released = await request(
          'DELETE',
          `/api/v1/projects/${holder}/repos?remote=${encodeURIComponent(repo)}`,
          undefined,
          { soft: true },
        )
        if (released) claimed = { released: repo, from: holder }
      }
    } else {
      // This used to write whatever it was handed. A mistyped key produced a
      // map that resolved to nothing, silently, for as long as it took someone
      // to wonder why the briefing had gone quiet.
      //
      // Store the key the server came back with rather than the spelling we
      // were given: this route resolves a uuid too, and a uuid in the map is 36
      // characters that every later /context rejects outright — which is the
      // same silence, reached by a route that looks like it validated.
      // A retired key resolves to the live project, and the request above has
      // already said so on stderr. What is stored is the LIVE key, so this
      // checkout stops sending the old one.
      const project = await request('GET', `/api/v1/projects/${encodeURIComponent(key)}`)
      map[dir] = project.key

      // Claim the repository too, so a second clone, a moved directory and a
      // worktree all resolve without being mapped again. Soft: an older server
      // has no such route, and that is no reason to refuse the local mapping.
      if (repo) {
        const linked = await request(
          'POST',
          `/api/v1/projects/${project.key}/repos`,
          { remote: repo, rootCommit: gitRootCommit(dir) },
          { soft: true },
        )
        if (linked) claimed = { linked: repo, to: project.key }
      }
    }

    mkdirSync(dirname(PROJECT_MAP_PATH), { recursive: true })
    writeFileSync(PROJECT_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`)
    emit({ path: dir, project: map[dir] ?? null, repo, ...(claimed ?? {}) })
  },

  /**
   * Is the memory still being written?
   *
   * Prints the findings and nothing else when there are any, because a report
   * nobody reads is the same as no report. `--all` shows the counts behind
   * them. `--notify <ref>` posts the findings as a note and says nothing when
   * there are none, which is what makes it safe to run on a schedule.
   */
  async vitals() {
    /**
     * Whether agents use the memory was measured but only ever displayed in a
     * browser, which is the one place the population it measures cannot look.
     * `null` when the aggregate is unreadable — the monitor still answers.
     */
    const memoryLines = (m) => {
      if (!m) return []
      const out = [
        `memory ${m.searches} searches (${m.widened} widened, ${m.zeroResults} empty), ` +
          `${m.tasksFiledWithoutChecking} of ${m.tasksFiled} tasks filed without checking first`,
      ]
      for (const miss of m.recentMisses ?? []) out.push(`  asked for, not held: ${miss}`)

      // Looking a fact up by name is the other half of consulting the memory,
      // and migration 053 is the first release to record it. Conditional, and
      // not because the number is uninteresting: a server on 052 sends neither
      // key, so an unconditional line would print `0 direct reads` for a
      // server that simply cannot count them. `?? 0` would turn that into a
      // confident wrong answer; absent has to stay absent. Zero-on-053 is
      // silent for the reason the block above it is skimmed at all — nothing
      // happened, and a line saying so is a line to learn to skip.
      const reads = m.directReads
      const missed = m.directReadMisses
      if ((reads ?? 0) > 0 || (missed ?? 0) > 0) {
        out.push(`direct reads ${reads ?? 0} by name (${missed ?? 0} for a slug we do not hold)`)
      }
      // One line each, like recentMisses, and said differently: a miss here is
      // not a subject the index phrased badly, it is a named fact an agent
      // believed existed. That is a dangling reference being followed live.
      for (const slug of m.recentSlugMisses ?? []) out.push(`  looked up by name, no such entry: ${slug}`)
      return out
    }

    /**
     * What migration 065 can see and cairn_vitals cannot: claims nobody is on,
     * the reaper, sessions and the summariser per runtime and host, knowledge
     * verification. Absent on an older server, and then nothing is printed —
     * `0 quiet` from a server that cannot count them would be a wrong answer.
     */
    const signalLines = (s) => {
      if (!s) return []
      const quiet = (m) => (m === null ? 'never active' : m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`)
      const out = [
        `claims ${s.claims.quiet2h} of ${s.claims.held} quiet >2h, ${s.claims.quiet24h} >24h; ` +
          `auto-released ${s.reaper.released7d} in 7d (last ${s.reaper.lastReleaseAt?.slice(0, 16) ?? 'never'})`,
      ]
      for (const c of s.claims.quietest.slice(0, 5)) {
        out.push(`  quiet ${quiet(c.quietMinutes)}: ${c.ref} ${truncate(c.title, 50)} (${c.claimedBy})`)
      }
      for (const r of s.runtimes) {
        out.push(
          `  ${r.runtime}@${r.host}: ${r.recent} sessions, ${r.recentSummarised} summarised ` +
            `(week before ${r.baseline}, ${r.baselineSummarised})`,
        )
      }
      if (s.sessions.summariserRecent > 0) {
        out.push(`  summariser runs not counted as sessions: ${s.sessions.summariserRecent}`)
      }
      out.push(
        `knowledge ${s.knowledge.neverVerified} of ${s.knowledge.current} never verified, ` +
          `${s.knowledge.unverified30d} not in 30 days`,
      )
      return out
    }

    const hours = Number(flags.hours ?? 24)
    const data = await request('GET', `/api/v1/vitals?hours=${hours}`)
    const findings = data.findings ?? []

    if (flags.notify) {
      if (findings.length === 0) {
        emit({ findings: 0, notified: false }, { lines: () => ['nothing to report'] })
        return
      }
      const note =
        `Cairn vitals, last ${data.windowHours}h:\n` +
        findings.map((f) => `  [${f.severity}] ${f.message}`).join('\n') +
        `\n\nSessions ${data.sessions.recent} (${data.sessions.recentWithFiles} naming files, ` +
        `${data.sessions.recentSummarised ?? '?'} summarised), ` +
        `tasks ${data.tasks.opened} opened / ${data.tasks.closed} closed, ` +
        `${data.tasks.stalled} stalled, ${data.autoReleased} claims auto-released.` +
        (signalLines(data.signals).length ? `\n${signalLines(data.signals).join('\n')}` : '') +
        (memoryLines(data.memory).length ? `\n${memoryLines(data.memory).join('\n')}` : '')
      await request('POST', `/api/v1/tasks/${encodeURIComponent(flags.notify)}/notes`, {
        note,
        kind: 'finding',
      })
      emit({ findings: findings.length, notified: true })
      return
    }

    emit(data, {
      lines: (d) => {
        const out = []
        if (d.findings.length === 0) out.push(`nothing wrong in the last ${d.windowHours}h`)
        for (const f of d.findings) out.push(`[${f.severity}] ${f.message}`)
        if (flags.all || d.findings.length === 0) {
          out.push('')
          out.push(
            `sessions ${d.sessions.recent} (${d.sessions.recentWithFiles} with files` +
              (d.sessions.recentSummarised !== undefined ? `, ${d.sessions.recentSummarised} summarised` : '') +
              `), week before ${d.sessions.baseline} (${d.sessions.baselineWithFiles})`,
          )
          out.push(
            `tasks ${d.tasks.opened} opened, ${d.tasks.closed} closed, ` +
              `${d.tasks.stalled} stalled, ${d.tasks.held} held`,
          )
          out.push(`claims auto-released ${d.autoReleased}, knowledge written ${d.knowledgeWritten}`)
          out.push(...signalLines(d.signals))
          out.push(...memoryLines(d.memory))
          for (const a of d.agents) out.push(`  ${a.agent}: ${a.recent} writes (week before ${a.baseline})`)
        }
        return out
      },
    })
  },

  async reconcile() {
    const body = { dryRun: Boolean(flags['dry-run']) }
    if (flags.older) body.olderThanMinutes = Number(flags.older)
    const data = await request('POST', '/api/v1/reconcile', body)
    emit(
      { count: data.released.length, ...data },
      {
        rows: (d) =>
          d.released.map((r) => ({
            ref: r.ref,
            holder: r.holder ?? '',
            held: `${r.heldForMinutes}m`,
            checkpoint: r.hadCheckpoint ? 'yes' : 'none',
          })),
        columns: ['ref', 'holder', 'held', 'checkpoint'],
      },
    )
  },

  // --- the episodic record -----------------------------------------------

  async session() {
    const verb = positional.shift() ?? 'list'

    if (verb === 'end' || verb === 'checkpoint') {
      const payload = {
        externalId: need(flags.id, `usage: cairn session ${verb} --id <session-id>`),
        platformSource: flags.platform ?? 'claude',
        cwd: flags.cwd ?? process.cwd(),
        files: splitList(flags.files),
        taskRefs: splitList(flags.tasks),
      }
      for (const [flag, field] of [
        ['project', 'project'], ['agent', 'agentId'], ['request', 'request'],
        ['learned', 'learned'], ['completed', 'completed'], ['next', 'nextSteps'],
        ['started', 'startedAt'],
      ]) {
        if (flags[flag] !== undefined) payload[field] = await resolveValue(flags[flag])
      }
      // The same order as `cairn context`: the map, then the remote (which the
      // server matches against project_repos), then the cwd on the server's
      // side. Nothing here used to look, and nothing else sent a project, so
      // every live session landed unattributed (CAIRN-286).
      if (payload.project === undefined) {
        const mapped = projectForDir(payload.cwd)
        if (mapped) payload.project = mapped
      }
      const repo = gitRemote(payload.cwd)
      if (repo) payload.repo = repo
      if (flags['tool-calls']) payload.toolCalls = Number(flags['tool-calls'])
      if (flags['no-checkpoint']) payload.checkpointHeld = false
      if (flags.scheduled) payload.scheduled = true
      if (verb === 'checkpoint') {
        payload.ongoing = true
        payload.checkpointHeld = false
      }
      return emit(await request('POST', '/api/v1/sessions', payload))
    }

    if (verb === 'list') {
      const params = new URLSearchParams()
      if (flags.project) params.set('project', flags.project)
      if (flags.cwd) params.set('cwd', flags.cwd)
      if (flags.limit) params.set('limit', flags.limit)
      const data = await request('GET', `/api/v1/sessions?${params}`)
      return emit(data, {
        // What came of it, not only what was asked. A list of requests is a
        // list of intentions; the reason to keep a session is the answer.
        rows: (d) => d.results.map((r) => ({
          ended: (r.endedAt ?? '').slice(0, 16).replace('T', ' '),
          agent: r.agent ?? r.platform,
          files: r.files,
          tasks: (r.taskRefs ?? []).join(','),
          request: truncate(r.request ?? (r.scheduled ? 'scheduled run' : ''), 44),
          outcome: truncate(r.completed ?? r.learned ?? '', 52),
        })),
        columns: ['ended', 'agent', 'files', 'tasks', 'request', 'outcome'],
      })
    }

    die(`unknown session verb "${verb}" — try: checkpoint, end, list`)
  },
}

const command = positional.shift()

if (flags.version || command === 'version') {
  // Asks the server too, and says when they disagree. A stale copy is
  // invisible otherwise: it goes on working, just not the way the docs say.
  // The comparison is the one every other request makes, through the same
  // function, so it is said once and only once.
  let server = null
  let res = null
  // The same refusal every other command gives, as a warning: the local
  // version is still worth answering with when the configuration is not.
  if (INSTANCE_REFUSAL) process.stderr.write(`${INSTANCE_REFUSAL.message}\n`)
  try {
    if (BASE && !INSTANCE_REFUSAL) {
      res = await fetch(`${BASE}/api/v1/health`)
      server = (await res.json())?.data ?? null
    }
  } catch {
    // Offline, or not pointed at a server yet. The local version still answers.
  }
  const mine = fingerprint()
  process.stdout.write(`cairn ${VERSION}${mine ? ` ${mine}` : ''}\n`)
  if (server) {
    process.stdout.write(`server ${server.version ?? '?'} (${server.build ?? '?'}) ${BASE}${INSTANCE.name ? ` [instance ${INSTANCE.name}]` : ''}\n`)
    warnIfStale(res)
  }
  process.exit(0)
}

if (!command || flags.help || command === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (!commands[command]) {
  die(`unknown command "${command}"\n\nvalid: ${Object.keys(commands).sort().join(' ')}`)
}
await commands[command]()

/**
 * Anything the caller typed that the command never looked at.
 *
 * `--json` and `--pretty` are read at module load, `--help` and `--version`
 * exit before this line, so the only thing left here is a flag that belongs to
 * a different verb, or to no verb at all — and in either case the caller
 * believes it took effect.
 *
 * Read verbs exit 2, because the answer looks filtered and is not and nothing
 * has happened yet. Write verbs do not: the write already went through, and an
 * exit code that says otherwise is how a caller ends up making it twice.
 */
const ignored = Object.keys(typedFlags).filter((flag) => !readFlags.has(flag))
if (ignored.length > 0) {
  const list = ignored.map((flag) => `--${flag}`).join(', ')
  process.stderr.write(
    `cairn: \`${command}\` does not take ${list} — ` +
      `it was accepted by the parser and then read by nothing.\n` +
      (mutated
        ? `The write went through WITHOUT it; re-run with the right flag if that was not what you meant.\n`
        : `Refused rather than answered: a filter that is dropped returns an answer that looks filtered and is not.\n`),
  )
  if (!mutated) process.exit(2)
}
