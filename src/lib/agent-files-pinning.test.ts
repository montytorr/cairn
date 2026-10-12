import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Issue #110: the agent-files job pulled unpinned code from `main` every
 * fifteen minutes and wrote it over the CLI, the hooks every session runs, and
 * itself. What is pinned here is the replacement contract:
 *
 * - the scheduled command names `release`, never a branch;
 * - `release` means the tag of the version the instance reports at
 *   /api/v1/health, and not knowing that version writes nothing at all;
 * - its own two scripts come from that same tag, verified and swapped in
 *   (agent-files-selfsync.test.ts holds the self-update contract);
 * - a checkout named by `cairn setup` (CAIRN_SETUP_SOURCE) is what gets
 *   scheduled, and `--runtimes` keeps a runtime nobody set up untouched.
 *
 * Every write goes to a temporary HOME. The sync also has a few targets outside
 * any home (/usr/local/bin/cairn, /opt/cairn-*), which it only ever updates
 * where they already exist; the cases that let it write are skipped on a
 * machine that has any of them, rather than risk replacing a real install with
 * test content.
 */

const REPO = process.cwd()
const NODE_DIR = dirname(process.execPath)
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`
const SYSTEM_TARGETS = [
  '/usr/local/bin/cairn',
  '/opt/cairn-maintenance/sync-agent-files.mjs',
  '/opt/cairn-maintenance/install-cron.mjs',
  '/opt/cairn-mcp/server.mjs',
].some((path) => existsSync(path))

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const run = (command: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

type Release = { version?: unknown; status?: number; missing?: string[] }

/**
 * An instance and a mirror in one: /api/v1/health answers what `health` says,
 * and /raw/v<version>/<file> serves a marker naming the file, so a copy on disk
 * says exactly which URL it came from.
 */
const serve = (health: Release | ((path: string) => Release)) =>
  new Promise<{ base: string; requests: string[] }>((resolve) => {
    const requests: string[] = []
    const server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push(path)
      const answer = typeof health === 'function' ? health(path) : health
      if (path === '/api/v1/health') {
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: true, data: { status: 'ok', version: answer.version } }))
      }
      const file = /^\/raw\/v[^/]+\/(.+)$/.exec(path)?.[1]
      if (file && !answer.missing?.includes(file)) {
        res.writeHead(200)
        // The maintenance scripts are run, so what stands in for them has to be
        // a script; the marker is the comment, and the program does nothing.
        return res.end(file.startsWith('scripts/') ? `#!/usr/bin/env node\n// pinned:${path}\n` : `pinned:${path}`)
      }
      res.writeHead(404)
      res.end('not found')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ base, requests })
    })
  })

/** A laptop with Claude Code and Codex directories, a CLI, hooks, and the two maintenance copies. */
const machine = async (instanceUrl?: string) => {
  const home = await temp('cairn-pin-home-')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(home, '.codex'), { recursive: true })
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await mkdir(join(home, '.cairn/hooks'), { recursive: true })
  await mkdir(join(home, '.cairn/maintenance'), { recursive: true })
  await writeFile(join(home, '.local/bin/cairn'), 'old cli')
  await writeFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'old sync')
  await writeFile(join(home, '.cairn/maintenance/install-cron.mjs'), 'old installer')
  if (instanceUrl) await writeFile(join(home, '.cairn/env'), `CAIRN_BASE_URL=${instanceUrl}\n`)
  return home
}

const sync = (home: string, args: string[]) =>
  run(process.execPath, ['scripts/sync-agent-files.mjs', ...args], {
    PATH: BASE_PATH,
    HOME: home,
    CAIRN_SYNC_RETRY_MS: '0',
  })

const untouched = async (home: string) => {
  expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('old cli')
  expect(existsSync(join(home, '.claude/skills/cairn/SKILL.md'))).toBe(false)
  expect(existsSync(join(home, '.cairn/hooks/cairn-context.mjs'))).toBe(false)
}

describe.skipIf(SYSTEM_TARGETS)('sync-agent-files --source release', () => {
  it('syncs the tag of the version the instance reports, and nothing from a branch', async () => {
    const { base, requests } = await serve({ version: '1.2.3' })
    const home = await machine(base)

    const result = await sync(home, ['--source', 'release', '--repo', `${base}/raw`])

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('release   v1.2.3')
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
    expect(await readFile(join(home, '.cairn/hooks/cairn-context.mjs'), 'utf8')).toBe(
      'pinned:/raw/v1.2.3/hooks/cairn-context.mjs',
    )
    const fetched = requests.filter((path) => path !== '/api/v1/health')
    expect(fetched.length).toBeGreaterThan(0)
    expect(fetched.every((path) => path.startsWith('/raw/v1.2.3/'))).toBe(true)
  })

  it('takes its own two scripts from the same tag, and reports them as drift under --check', async () => {
    const { base, requests } = await serve({ version: '1.2.3' })
    const home = await machine(base)

    const checked = await sync(home, ['--source', 'release', '--repo', `${base}/raw`, '--check'])
    expect(checked.code, checked.stdout).toBe(1)
    expect(checked.stdout).toMatch(/DRIFT\s+\S*sync-agent-files\.mjs/)
    expect(await readFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'utf8')).toBe('old sync')

    const written = await sync(home, ['--source', 'release', '--repo', `${base}/raw`])

    expect(written.code, written.stdout).toBe(0)
    expect(await readFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'utf8')).toContain(
      'pinned:/raw/v1.2.3/scripts/sync-agent-files.mjs',
    )
    expect(await readFile(join(home, '.cairn/maintenance/install-cron.mjs'), 'utf8')).toContain(
      'pinned:/raw/v1.2.3/scripts/install-cron.mjs',
    )
    expect(requests.filter((path) => path.includes('scripts/')).every((path) => path.startsWith('/raw/v1.2.3/'))).toBe(true)
  })

  it('reads the pre-#110 default URL as release, unless the job says --unpinned', async () => {
    const { base, requests } = await serve({ version: '1.2.3' })
    const home = await machine(base)

    const result = await sync(home, [
      '--source', 'https://raw.githubusercontent.com/montytorr/cairn/main',
      '--repo', `${base}/raw`,
    ])

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('pre-#110 default')
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
    expect(requests).toContain('/api/v1/health')
  })

  it('leaves the skill of a runtime that was not set up alone', async () => {
    const { base } = await serve({ version: '1.2.3' })
    const home = await machine(base)

    const result = await sync(home, ['--source', 'release', '--repo', `${base}/raw`, '--runtimes', 'claude-code'])

    expect(result.code, result.stdout).toBe(0)
    expect(existsSync(join(home, '.claude/skills/cairn/SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.agents/skills/cairn/SKILL.md'))).toBe(false)
    expect(result.stdout).toContain('(codex was not set up here)')
  })

  const several = async (instances: Record<string, { url: string }>, unclassified: object) => {
    const home = await machine()
    await writeFile(join(home, '.cairn/instances.json'), JSON.stringify({ version: 1, instances, unclassified }))
    return home
  }

  it('follows the newest release on a machine with several, even when the default runs an older one', async () => {
    const work = await serve({ version: '1.2.3' })
    const personal = await serve({ version: '1.10.0' })
    const home = await several({ work: { url: work.base }, personal: { url: personal.base } }, { mode: 'default', instance: 'work' })

    const result = await sync(home, ['--source', 'release', '--repo', `${work.base}/raw`])

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.10.0/cli/cairn.mjs')
    expect(result.stdout).toContain('release   v1.10.0 (personal; also work 1.2.3)')
  })

  it('follows the newest when there is no default, instead of refusing instances that disagree', async () => {
    const a = await serve({ version: '1.3.0-rc.1' })
    const b = await serve({ version: '1.3.0' })
    const c = await serve({ version: '1.2.9' })
    const home = await several({ a: { url: a.base }, b: { url: b.base }, c: { url: c.base } }, { mode: 'ask' })

    const result = await sync(home, ['--source', 'release', '--repo', `${a.base}/raw`])

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.3.0/cli/cairn.mjs')
  })

  it('leaves out an instance that cannot be asked, and follows the ones that answer', async () => {
    const reachable = await serve({ version: '1.2.3' })
    const walled = await serve({ status: 403, version: '9.9.9' })
    const home = await several({ reachable: { url: reachable.base }, walled: { url: walled.base } }, { mode: 'default', instance: 'walled' })

    const result = await sync(home, ['--source', 'release', '--repo', `${reachable.base}/raw`])

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
    expect(result.stdout).toMatch(/skipped {3}walled: .*answered 403/)
  })

  it('updates its own scripts from a tree on disk, which somebody put there on purpose', async () => {
    const home = await machine()

    const result = await sync(home, ['--source', REPO])

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'utf8')).toBe(
      await readFile(join(REPO, 'scripts/sync-agent-files.mjs'), 'utf8'),
    )
  })
})

describe('sync-agent-files --source release, when the release cannot be known', () => {
  const refused = async (home: string, args: string[], why: RegExp) => {
    const result = await sync(home, args)
    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toMatch(why)
    expect(result.stdout).toContain('Nothing was written')
    await untouched(home)
    expect(await readFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'utf8')).toBe('old sync')
  }

  it('writes nothing when the instance does not answer', async () => {
    const { base } = await serve({ status: 503, version: '1.2.3' })
    await refused(await machine(base), ['--source', 'release', '--repo', `${base}/raw`], /answered 503/)
  })

  it('writes nothing when the instance is unreachable', async () => {
    const { base } = await serve({ version: '1.2.3' })
    await new Promise((done) => servers.splice(0).forEach((s) => s.close(done)))
    await refused(await machine(base), ['--source', 'release', '--repo', `${base}/raw`], /could not ask/)
  })

  it('writes nothing when no instance is configured', async () => {
    await refused(await machine(), ['--source', 'release'], /no instance to pin to/)
  })

  it.each([['main'], ['1.2.3/../../evil'], ['v1.2.3'], [''], [null]])(
    'refuses %j as a version rather than building a URL from it',
    async (version) => {
      const { base, requests } = await serve({ version })
      await refused(await machine(base), ['--source', 'release', '--repo', `${base}/raw`], /not a release number/)
      expect(requests).toEqual(['/api/v1/health'])
    },
  )

  it('writes nothing when one file of the release is missing, not the files before it', async () => {
    const { base } = await serve({ version: '1.2.3', missing: ['mcp/server.mjs'] })
    await refused(await machine(base), ['--source', 'release', '--repo', `${base}/raw`], /mcp\/server\.mjs returned 404/)
  })

  it('refuses a mirror over plain http', async () => {
    const { base } = await serve({ version: '1.2.3' })
    await refused(await machine(base), ['--source', 'release', '--repo', 'http://mirror.example/cairn'], /is not https/)
  })

  it('writes nothing when none of several instances answers', async () => {
    const a = await serve({ status: 403, version: '1.2.3' })
    const b = await serve({ status: 503, version: '1.3.0' })
    const home = await machine()
    await writeFile(join(home, '.cairn/instances.json'), JSON.stringify({
      version: 1,
      instances: { a: { url: a.base }, b: { url: b.base } },
      unclassified: { mode: 'ask' },
    }))
    await refused(home, ['--source', 'release', '--repo', `${a.base}/raw`], /no instance said which release it runs .*a: .*403.*b: .*503/)
  })
})

/** The agent-files job as install-cron would schedule it, printed and never installed. */
const plan = async (args: string[] = [], extra: Record<string, string> = {}) => {
  const home = await temp('cairn-pin-cron-')
  const script = join(home, 'sync.mjs')
  await writeFile(script, '')
  const result = await run(process.execPath, ['scripts/install-cron.mjs', '--cron', '--only', 'agent-files', ...args], {
    PATH: BASE_PATH,
    HOME: home,
    CAIRN_SYNC_SCRIPT: script,
    CAIRN_NODE_PATH: process.execPath,
    CAIRN_LOG_DIR: home,
    ...extra,
  })
  const line = result.stdout.split('\n').find((l) => l.startsWith('23 * * * *')) ?? ''
  return { ...result, line, home }
}

describe('install-cron — the agent-files job source', () => {
  it('schedules the release the instance runs, from the public repository, never main', async () => {
    const { code, line } = await plan()
    expect(code).toBe(0)
    expect(line).toContain("'--source' 'release' '--repo' 'https://raw.githubusercontent.com/montytorr/cairn'")
    expect(line).not.toContain('/main')
    expect(line).not.toContain('--unpinned')
  })

  it('follows a fork named by CAIRN_REPO, and refuses one that is not <owner>/<name>', async () => {
    const fork = await plan([], { CAIRN_REPO: 'acme/cairn' })
    expect(fork.line).toContain("'--repo' 'https://raw.githubusercontent.com/acme/cairn'")

    for (const bad of ['acme', 'acme/cairn/extra', 'acme/..', 'a b/c']) {
      const refused = await plan([], { CAIRN_REPO: bad })
      expect(refused.code, bad).toBe(2)
      expect(refused.stderr).toContain('is not <owner>/<name>')
    }
  })

  it('schedules a checkout given with --source, as cairn setup passes CAIRN_SETUP_SOURCE', async () => {
    const { code, line } = await plan(['--source', REPO, '--runtimes', 'claude-code'])
    expect(code).toBe(0)
    expect(line).toContain(`'--source' '${REPO}' '--runtimes' 'claude-code'`)
    expect(line).not.toContain('--repo')

    const notACheckout = await plan(['--source', tmpdir()])
    expect(notACheckout.code).toBe(2)
    expect(notACheckout.stderr).toContain('is not a Cairn checkout')
  })

  it('follows CAIRN_RAW_BASE only as an explicit, labelled opt-in', async () => {
    const { line } = await plan([], { CAIRN_RAW_BASE: 'https://raw.example/main' })
    expect(line).toContain("'--source' 'https://raw.example/main' '--unpinned'")
  })

  it('drops --repo when --run swaps the scheduled source for a tree on disk', async () => {
    const home = await temp('cairn-pin-run-')
    const recorded = join(home, 'recorded.json')
    const recorder = join(home, 'recorder.mjs')
    await writeFile(recorder, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2)))
`)
    const env = {
      PATH: BASE_PATH,
      HOME: home,
      RECORD: recorded,
      CAIRN_SYNC_SCRIPT: recorder,
      CAIRN_NODE_PATH: process.execPath,
      CAIRN_LOG_DIR: home,
    }
    const printed = await run(process.execPath, ['scripts/install-cron.mjs', '--only', 'agent-files', '--launchd'], env)
    const plist = printed.stdout.slice(printed.stdout.indexOf('<?xml'), printed.stdout.indexOf('</plist>') + 9)
    await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true })
    await writeFile(join(home, 'Library/LaunchAgents/com.cairn.agent-files.plist'), plist)

    const result = await run(
      process.execPath,
      ['scripts/install-cron.mjs', '--run', 'agent-files', '--launchd', '--source', REPO],
      env,
    )

    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual(['--source', REPO])
  })
})

describe('install-hooks --runtimes', () => {
  it('leaves ~/.codex/hooks.json alone when only claude-code was set up', async () => {
    const home = await temp('cairn-pin-hooks-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.claude/settings.json'), '{}')

    const result = await run(process.execPath, ['scripts/install-hooks.mjs', '--runtimes', 'claude-code'], {
      PATH: BASE_PATH,
      HOME: home,
      CAIRN_OPENCLAW_BIN: 'openclaw-not-installed',
    })

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false)
    expect(result.stdout).toContain('codex: not in --runtimes — skipped')
    const claude = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))
    expect(Object.keys(claude.hooks)).toContain('SessionStart')
  })
})

describe('install.sh CAIRN_REPO', () => {
  it.each([['acme'], ['acme/cairn/extra'], ['acme/..'], ['../cairn'], ['acme/ca rn'], ['https://evil.example/x']])(
    'refuses %j before downloading anything',
    async (repo) => {
      const home = await temp('cairn-pin-install-')
      const result = await run('sh', ['install.sh', '--url', 'http://127.0.0.1:9'], {
        PATH: BASE_PATH,
        HOME: home,
        CAIRN_REPO: repo,
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('is not <owner>/<name>')
      expect(existsSync(join(home, '.local'))).toBe(false)
    },
  )
})
