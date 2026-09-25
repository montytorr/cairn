import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { hostOf } from './api/auth'
import { withHost } from './api/activity'

/**
 * CAIRN-290: the ways a correctly written CLI still ended up speaking with the
 * wrong identity, from the wrong machine, or out of date — each exercised the
 * way a runtime meets it, by spawning the real file.
 *
 * Every environment below is built from nothing rather than from
 * process.env, because this suite is itself usually run from inside Claude
 * Code or Codex, and their markers leaking in would make detection pass for
 * the wrong reason.
 */

const REPO = resolve(__dirname, '../..')
const CLI = join(REPO, 'cli/cairn.mjs')
const NODE_DIR = dirname(process.execPath)
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

type Seen = { url: string; headers: IncomingHttpHeaders }

const serve = (headers: Record<string, string> = {}) =>
  new Promise<{ base: string; seen: Seen[] }>((done) => {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      const data = req.url?.startsWith('/api/v1/health')
        ? { status: 'ok', version: headers['x-cairn-version'] ?? '0.0.0', build: 'test' }
        : []
      res.end(JSON.stringify({ success: true, data }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () =>
      done({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }),
    )
  })

const run = (command: string, args: string[], env: Record<string, string>, cwd = REPO) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })

const homeWith = async (envFile: string) => {
  const home = await temp('cairn-wiring-home-')
  await mkdir(join(home, '.cairn'))
  await writeFile(join(home, '.cairn/env'), envFile)
  return home
}

const bearer = (seen: Seen[]) => String(seen[0]?.headers.authorization ?? '').replace(/^Bearer /, '')

const SPLIT = [
  'CAIRN_API_KEY=cairn_default',
  'CAIRN_API_KEY_CLAUDE_CODE=cairn_claude',
  'CAIRN_API_KEY_CODEX=cairn_codex',
].join('\n')

/**
 * A stand-in for a runtime binary: a node script called `codex` or `claude`
 * that runs the command it is handed. What matters is its name in the process
 * table, which is all the CLI looks at.
 */
const fakeRuntime = async (dir: string, name: 'codex' | 'claude') => {
  const path = join(dir, name)
  await writeFile(
    path,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const [command, ...args] = process.argv.slice(2)
const r = spawnSync(command, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
`,
  )
  await chmod(path, 0o755)
  return path
}

describe('which runtime is innermost', () => {
  const setUp = async () => {
    const { base, seen } = await serve()
    const home = await homeWith(SPLIT)
    const bin = await temp('cairn-wiring-bin-')
    const codex = await fakeRuntime(bin, 'codex')
    const claude = await fakeRuntime(bin, 'claude')
    const env = { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_HOST: 'test-box' }
    return { seen, env, codex, claude }
  }

  it('files a Codex started from a Claude Code shell as Codex', async () => {
    const { seen, env, codex } = await setUp()
    // Exactly what that Codex's commands see: Claude Code's marker, inherited,
    // and Codex's own.
    const nested = { ...env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: 't-1' }
    const out = await run(codex, ['node', CLI, 'projects'], nested)
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('cairn_codex')
  })

  it('files a Claude Code started from a Codex shell as Claude Code', async () => {
    const { seen, env, codex, claude } = await setUp()
    const nested = { ...env, CLAUDECODE: '1', CODEX_THREAD_ID: 't-1', CODEX_MANAGED_BY_NPM: '1' }
    const out = await run(codex, [claude, 'node', CLI, 'projects'], nested)
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('cairn_claude')
  })

  it('keeps plain Claude Code as Claude Code, and plain Codex as Codex', async () => {
    const claudeOnly = await setUp()
    await run('node', [CLI, 'projects'], { ...claudeOnly.env, CLAUDECODE: '1' })
    expect(bearer(claudeOnly.seen)).toBe('cairn_claude')

    const codexOnly = await setUp()
    await run('node', [CLI, 'projects'], { ...codexOnly.env, CODEX_THREAD_ID: 't-2' })
    expect(bearer(codexOnly.seen)).toBe('cairn_codex')
  })

  it('keeps the old answer when the process tree names no runtime', async () => {
    const { seen, env } = await setUp()
    await run('node', [CLI, 'projects'], { ...env, CLAUDECODE: '1', CODEX_THREAD_ID: 't-3' })
    expect(bearer(seen)).toBe('cairn_claude')
  })
})

describe('the maintenance identity never borrows a key', () => {
  it('refuses, loudly and before sending anything, when it has no key of its own', async () => {
    const { base, seen } = await serve()
    const home = await homeWith(SPLIT)
    const out = await run('node', [CLI, 'note', 'CAIRN-1', 'x'], {
      PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_AGENT: 'maintenance',
    })
    expect(out.code).toBe(3)
    expect(out.stderr).toContain('CAIRN_API_KEY_MAINTENANCE')
    expect(seen).toHaveLength(0)
  })

  it('uses its own key when there is one', async () => {
    const { base, seen } = await serve()
    const home = await homeWith(`${SPLIT}\nCAIRN_API_KEY_MAINTENANCE=cairn_maint`)
    const out = await run('node', [CLI, 'projects'], {
      PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_AGENT: 'maintenance',
    })
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('cairn_maint')
  })

  it('still works on a machine that was never split into per-runtime keys', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    const out = await run('node', [CLI, 'projects'], {
      PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_AGENT: 'maintenance',
    })
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('cairn_only')
  })

  it('makes the sync job say so on every run, not only when it reports', async () => {
    const home = await homeWith(SPLIT)
    // --check writes nothing, which matters: the sync's targets include
    // /usr/local/bin/cairn on whatever machine runs this suite.
    const out = await run('node', ['scripts/sync-agent-files.mjs', '--check', '--notify', 'CAIRN-1'], {
      PATH: BASE_PATH, HOME: home, CAIRN_AGENT: 'maintenance',
    })
    expect(out.stdout).toContain('WARNING: CAIRN_AGENT=maintenance')
    expect(out.stdout).toContain('CAIRN_API_KEY_MAINTENANCE')
    expect(out.code).not.toBe(0)
  })
})

describe('the machine travels beside the actor', () => {
  it('sends the host, and the actor key is unchanged', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_HOST: 'clawdius' })
    expect(seen[0]?.headers['x-cairn-host']).toBe('clawdius')
  })

  it('drops a host it could not store safely rather than sanitising it', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base, CAIRN_HOST: 'a b;c' })
    expect(seen[0]?.headers['x-cairn-host']).toBeUndefined()
  })

  it('is read by the server with the same filter, and folded into event data', () => {
    const req = (host?: string) =>
      new Request('http://x', { headers: host === undefined ? {} : { 'x-cairn-host': host } })
    expect(hostOf(req('mac-mini.local'))).toBe('mac-mini.local')
    expect(hostOf(req('a b'))).toBeNull()
    expect(hostOf(req())).toBeNull()

    const event = { actor_type: 'agent', actor_id: 'codex · a@b', event: 'claimed', data: { x: 1 } }
    expect(withHost([event], 'box')[0]!.data).toEqual({ x: 1, host: 'box' })
    expect(withHost([event], null)[0]).toBe(event)
    expect(withHost([{ ...event, data: { host: 'kept' } }], 'box')[0]!.data).toEqual({ host: 'kept' })
  })
})

describe('which side of a drift is newer', () => {
  const release = async () => JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version as string

  const warn = async (headers: Record<string, string>, args = ['projects']) => {
    const { base } = await serve(headers)
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    return run('node', [CLI, ...args], { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base })
  }

  it('says the CLI is older when the server is a later release', async () => {
    const { stderr } = await warn({ 'x-cairn-version': '99.0.0' })
    expect(stderr).toContain('this CLI is older than the server')
    expect(stderr).toContain('update:')
  })

  it('says the CLI is newer when the server is an earlier release, and does not tell it to update', async () => {
    const { stderr } = await warn({ 'x-cairn-version': '0.0.1' })
    expect(stderr).toContain('this CLI is newer than the server')
    expect(stderr).not.toContain('update:')
  })

  it('orders the same release by build time against install time', async () => {
    const version = await release()
    const future = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
    const older = await warn({ 'x-cairn-version': version, 'x-cairn-cli': '0123456789abcdef', 'x-cairn-built-at': future })
    expect(older.stderr).toContain('this CLI is older than the server')

    const newer = await warn({ 'x-cairn-version': version, 'x-cairn-cli': '0123456789abcdef', 'x-cairn-built-at': '2001-01-01T00:00:00Z' })
    expect(newer.stderr).toContain('this CLI is newer than the server')
  })

  it('is neutral when nothing can order them', async () => {
    const { stderr } = await warn({ 'x-cairn-version': await release(), 'x-cairn-cli': '0123456789abcdef' })
    expect(stderr).toContain('CLI and server differ')
  })

  it('names the scheduled job when this machine has one', async () => {
    const { base } = await serve({ 'x-cairn-version': '99.0.0' })
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    await mkdir(join(home, '.cairn/maintenance'), { recursive: true })
    await writeFile(join(home, '.cairn/maintenance/install-cron.mjs'), '')
    const agent = join(home, 'Library/LaunchAgents/com.cairn.agent-files.plist')
    await mkdir(dirname(agent), { recursive: true })
    await writeFile(agent, '')
    const { stderr } = await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base })
    expect(stderr).toContain(
      process.platform === 'darwin'
        ? 'launchctl kickstart gui/'
        : `node ${join(home, '.cairn/maintenance/install-cron.mjs')} --run agent-files`,
    )
  })

  it('--version says it once', async () => {
    const { stdout, stderr } = await warn({ 'x-cairn-version': '99.0.0' }, ['--version'])
    expect(stdout).toContain('server 99.0.0')
    expect(stderr.match(/older than the server/g)).toHaveLength(1)
  })

  it('reads install time from the file itself', async () => {
    // A copy whose mtime is older than the build: the Mac after a merge.
    const dir = await temp('cairn-wiring-copy-')
    const copy = join(dir, 'cairn.mjs')
    await writeFile(copy, `${await readFile(CLI, 'utf8')}\n// drifted\n`)
    await utimes(copy, new Date('2001-01-01'), new Date('2001-01-01'))
    const { base } = await serve({
      'x-cairn-version': await release(),
      'x-cairn-cli': '0123456789abcdef',
      'x-cairn-built-at': '2020-01-01T00:00:00Z',
    })
    const home = await homeWith('CAIRN_API_KEY=cairn_only')
    const { stderr } = await run('node', [copy, 'projects'], { PATH: BASE_PATH, HOME: home, CAIRN_BASE_URL: base })
    expect(stderr).toContain('this CLI is older than the server')
  })
})

describe('the installer and the per-Read hook CCS-40 removed', () => {
  const READ_HOOK = (prefix = '') => ({
    matcher: 'Read',
    hooks: [{ type: 'command', command: `${prefix}node /old/home/.cairn/hooks/cairn-context.mjs`, async: true, timeout: 10 }],
  })

  it('takes out its own Read hook, keeps everyone else’s, and is idempotent', async () => {
    const home = await temp('cairn-wiring-hooks-')
    await mkdir(join(home, '.claude'))
    await mkdir(join(home, '.codex'))
    const foreignPre = { type: 'command', command: '/someone/else/pre.sh' }
    await writeFile(
      join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [READ_HOOK().hooks[0], foreignPre] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '/guard.sh' }] },
          ],
        },
      }),
    )
    const quarry = { type: 'command', command: 'node /x/.quarry/hooks/quarry-session-end.mjs' }
    await writeFile(
      join(home, '.codex/hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [READ_HOOK('CAIRN_AGENT=codex ')], Stop: [{ hooks: [quarry] }] } }),
    )

    const env = { PATH: BASE_PATH, HOME: home }
    const first = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(first.code, first.stderr).toBe(0)

    const claude = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))
    expect(claude.hooks.PreToolUse).toEqual([
      { matcher: 'Read', hooks: [foreignPre] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/guard.sh' }] },
    ])
    expect(Object.keys(claude.hooks).sort()).toEqual(['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart'])

    const codex = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    expect(codex.hooks.PreToolUse).toBeUndefined()
    // Somebody else's hook: warned about, never removed.
    expect(codex.hooks.Stop.flatMap((g: { hooks: unknown[] }) => g.hooks)).toContainEqual(quarry)
    expect(first.stdout).toContain('Stop (runs every turn): node /x/.quarry/hooks/quarry-session-end.mjs')
    expect(first.stdout).toContain('removed the per-Read PreToolUse hook')

    const second = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout).toContain(`${join(home, '.claude/settings.json')} — unchanged`)
    expect(second.stdout).toContain(`${join(home, '.codex/hooks.json')} — unchanged`)
  })
})

describe('the Mac sync job', () => {
  const render = async (flag: string) => {
    const home = await temp('cairn-wiring-cron-')
    const sync = join(home, 'sync.mjs')
    const cli = join(home, 'cairn')
    await writeFile(sync, '')
    await writeFile(cli, '')
    return run('node', ['scripts/install-cron.mjs', flag], {
      PATH: BASE_PATH,
      HOME: home,
      CAIRN_SYNC_SCRIPT: sync,
      CAIRN_CLI_PATH: cli,
      CAIRN_NODE_PATH: process.execPath,
      CAIRN_LOG_DIR: home,
    })
  }

  const agentFilesPlist = (stdout: string) => {
    const start = stdout.indexOf('<string>com.cairn.agent-files</string>')
    return stdout.slice(start, stdout.indexOf('</plist>', start))
  }

  it('runs at load and every quarter hour under launchd, so a wake is never an hour late', async () => {
    const { stdout } = await render('--launchd')
    const plist = agentFilesPlist(stdout)
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    for (const minute of [0, 15, 30, 45]) {
      expect(plist).toContain(`<key>Minute</key><integer>${minute}</integer>`)
    }
    expect(plist).not.toContain('<key>StartInterval</key>')
    // Nothing else changed: the other jobs still wait for their slot.
    const reconcile = stdout.slice(stdout.indexOf('<string>com.cairn.reconcile</string>'))
    expect(reconcile.slice(0, reconcile.indexOf('</plist>'))).toContain('<key>RunAtLoad</key><false/>')
  })

  it('leaves the server crontab hourly, where the deploy is the trigger', async () => {
    const { stdout } = await render('--cron')
    expect(stdout).toMatch(/^23 \* \* \* \* CAIRN_AGENT=maintenance .*sync\.mjs/m)
  })
})
