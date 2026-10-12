import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The Lab's workflow lives in skills/cairn/lab.md, beside SKILL.md, so an
 * instance without the Lab does not pay for it in every session. That only
 * works if every way a skill reaches a machine carries the second file:
 * `cairn setup`, the agent-files job (the scheduled sync), and a copy kept in
 * a runtime's own tree (`--also skill=…`). A pointer to a file that never
 * arrived is worse than no pointer.
 *
 * Everything writes to a temporary HOME. The sync also has targets outside any
 * home, which it only updates where they already exist; those cases are
 * skipped on a machine that has one rather than risk its real install.
 */
const REPO = process.cwd()
const CLI = join(REPO, 'cli', 'cairn.mjs')
const SYNC = join(REPO, 'scripts', 'sync-agent-files.mjs')
const SYSTEM_TARGETS = [
  '/usr/local/bin/cairn',
  '/opt/cairn-maintenance/sync-agent-files.mjs',
  '/opt/cairn-maintenance/install-cron.mjs',
  '/opt/cairn-mcp/server.mjs',
].some((path) => existsSync(path))

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

const exec = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', args, { env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

/** A Cairn that approves a pairing, and a mirror that serves a marker for any release file. */
const serve = () =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const json = (data: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data }))
        }
        const path = req.url ?? ''
        if (path === '/api/v1/health') return json({ version: '1.2.3', status: 'ok' })
        if (path === '/api/v1/people') return json([])
        if (path === '/api/v1/connect') {
          return json({ deviceCode: 'd', userCode: 'AB12-CD34', verificationUrl: 'http://127.0.0.1/c', expiresIn: 60, interval: 0 })
        }
        if (path === '/api/v1/connect/poll') {
          return json({ status: 'approved', user: { name: 'T' }, keys: [{ agentName: 'claude-code', key: 'sk_a' }, { agentName: 'codex', key: 'sk_b' }] })
        }
        const file = /^\/raw\/v[^/]+\/(.+)$/.exec(path)?.[1]
        if (file) {
          res.writeHead(200)
          // The maintenance scripts are verified as scripts before they are written.
          return res.end(file.startsWith('scripts/') ? `#!/usr/bin/env node\n// pinned:${path}\n` : `pinned:${path}`)
        }
        res.writeHead(404)
        res.end('not found')
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const skillFolders = (home: string) => [join(home, '.claude/skills/cairn'), join(home, '.agents/skills/cairn')]

describe('cairn setup carries the whole skill folder', () => {
  it('writes lab.md and reference.md beside SKILL.md for every runtime, and says nothing changed the second time', async () => {
    const base = await serve()
    const home = await temp('cairn-lab-skill-')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, CAIRN_SETUP_SOURCE: REPO, PATH: process.env.PATH ?? '' }
    delete env.CAIRN_AGENT
    const args = [CLI, 'setup', '--url', base, '--runtimes', 'claude-code,codex', '--no-hooks', '--no-jobs']

    const first = await exec(args, env)
    expect(first.code, first.stdout + first.stderr).toBe(0)
    const skill = await readFile(join(REPO, 'skills/cairn/SKILL.md'), 'utf8')
    const lab = await readFile(join(REPO, 'skills/cairn/lab.md'), 'utf8')
    const reference = await readFile(join(REPO, 'skills/cairn/reference.md'), 'utf8')
    for (const folder of skillFolders(home)) {
      expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe(skill)
      expect(await readFile(join(folder, 'lab.md'), 'utf8')).toBe(lab)
      expect(await readFile(join(folder, 'reference.md'), 'utf8')).toBe(reference)
    }

    const second = await exec(args, env)
    expect(second.stdout).toMatch(/– skill\s+.*unchanged/)
  })

  it('setup retires the deprecated ~/.codex copy so Codex does not list the skill twice', async () => {
    const base = await serve()
    const home = await temp('cairn-lab-skill-')
    const old = join(home, '.codex/skills/cairn')
    await mkdir(old, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(old, 'SKILL.md'), 'old')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, CAIRN_SETUP_SOURCE: REPO, PATH: process.env.PATH ?? '' }
    delete env.CAIRN_AGENT
    const out = await exec([CLI, 'setup', '--url', base, '--runtimes', 'codex', '--no-hooks', '--no-jobs'], env)
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(existsSync(join(home, '.agents/skills/cairn/SKILL.md'))).toBe(true)
    expect(existsSync(old)).toBe(false)
  })

  it('setup in a home OpenClaw shares keeps Codex at ~/.codex/skills and retires nothing', async () => {
    const base = await serve()
    const home = await temp('cairn-lab-skill-')
    const gateway = await temp('cairn-lab-gateway-')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, CLAWD_HOME: gateway, CAIRN_SETUP_SOURCE: REPO, PATH: process.env.PATH ?? '' }
    delete env.CAIRN_AGENT
    const out = await exec([CLI, 'setup', '--url', base, '--runtimes', 'codex,openclaw', '--no-hooks', '--no-jobs'], env)
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(existsSync(join(home, '.codex/skills/cairn/SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.agents'))).toBe(false)
    expect(existsSync(join(gateway, 'skills/cairn/SKILL.md'))).toBe(true)
  })

  it('setup does not delete the old Codex copy when the new SKILL.md was not written', async () => {
    const base = await serve()
    const home = await temp('cairn-lab-skill-')
    const old = join(home, '.codex/skills/cairn')
    await mkdir(old, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(old, 'SKILL.md'), 'old')
    // ~/.agents is a file, so the new folder cannot be created.
    await writeFile(join(home, '.agents'), 'in the way')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, CAIRN_SETUP_SOURCE: REPO, PATH: process.env.PATH ?? '' }
    delete env.CAIRN_AGENT
    await exec([CLI, 'setup', '--url', base, '--runtimes', 'codex', '--no-hooks', '--no-jobs'], env)
    expect(await readFile(join(old, 'SKILL.md'), 'utf8')).toBe('old')
  })

  it('a dry run names the folder it would write, lab.md included', async () => {
    const base = await serve()
    const home = await temp('cairn-lab-skill-')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, CAIRN_SETUP_SOURCE: REPO, PATH: process.env.PATH ?? '' }
    delete env.CAIRN_AGENT
    const out = await exec([CLI, 'setup', '--url', base, '--runtimes', 'claude-code', '--dry-run'], env)
    expect(out.stdout).toContain('would write ~/.claude/skills/cairn')
    expect(existsSync(join(home, '.claude/skills/cairn/lab.md'))).toBe(false)
    expect(existsSync(join(home, '.claude/skills/cairn/reference.md'))).toBe(false)
  })
})

describe.skipIf(SYSTEM_TARGETS)('the agent-files job carries it too', () => {
  const machine = async (base: string) => {
    const home = await temp('cairn-lab-sync-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(home, '.codex'), { recursive: true })
    await mkdir(join(home, '.cairn'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, '.cairn/env'), `CAIRN_BASE_URL=${base}\n`)
    return home
  }
  const sync = (home: string, base: string, extra: string[] = []) =>
    exec([SYNC, '--source', 'release', '--repo', `${base}/raw`, ...extra], {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      CAIRN_SYNC_RETRY_MS: '0',
    })

  it('places lab.md beside the skill it repairs, from the same release', async () => {
    const base = await serve()
    const home = await machine(base)
    const out = await sync(home, base)
    expect(out.code, out.stdout).toBe(0)
    for (const folder of skillFolders(home)) {
      expect(await readFile(join(folder, 'lab.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/lab.md')
      expect(await readFile(join(folder, 'reference.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/reference.md')
      expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/SKILL.md')
    }
  })

  it('leaves a runtime nobody set up alone', async () => {
    const base = await serve()
    const home = await machine(base)
    const out = await sync(home, base, ['--runtimes', 'claude-code'])
    expect(out.code, out.stdout).toBe(0)
    expect(existsSync(join(home, '.claude/skills/cairn/lab.md'))).toBe(true)
    expect(existsSync(join(home, '.agents/skills/cairn/lab.md'))).toBe(false)
    expect(existsSync(join(home, '.claude/skills/cairn/reference.md'))).toBe(true)
    expect(existsSync(join(home, '.agents/skills/cairn/reference.md'))).toBe(false)
  })

  it('a copy kept in a runtime\'s own tree (--also skill=) takes lab.md and reference.md along', async () => {
    const base = await serve()
    const home = await machine(base)
    const gateway = await temp('cairn-lab-gateway-')
    // Repaired where it was installed, never created: its folder exists.
    await mkdir(join(gateway, 'skills/cairn'), { recursive: true })
    const out = await sync(home, base, ['--also', `skill=${join(gateway, 'skills/cairn/SKILL.md')}`])
    expect(out.code, out.stdout).toBe(0)
    expect(await readFile(join(gateway, 'skills/cairn/SKILL.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/SKILL.md')
    expect(await readFile(join(gateway, 'skills/cairn/lab.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/lab.md')
    expect(await readFile(join(gateway, 'skills/cairn/reference.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/reference.md')
  })

  it('puts Codex\'s skill in ~/.agents/skills and retires the deprecated copy, so Codex lists it once', async () => {
    const base = await serve()
    const home = await machine(base)
    const old = join(home, '.codex/skills/cairn')
    await mkdir(old, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    for (const name of ['SKILL.md', 'lab.md', 'reference.md']) await writeFile(join(old, name), 'old')

    const drift = await sync(home, base, ['--check'])
    expect(drift.code).toBe(1)
    expect(drift.stdout).toMatch(/DRIFT\s+\S*\.agents\/skills\/cairn\/SKILL\.md\s+\(missing\)/)

    const out = await sync(home, base)
    expect(out.code, out.stdout).toBe(0)
    for (const name of ['SKILL.md', 'lab.md', 'reference.md']) {
      expect(existsSync(join(home, '.agents/skills/cairn', name))).toBe(true)
      expect(existsSync(join(old, name))).toBe(false)
    }
    expect(existsSync(old)).toBe(false)
    const clean = await sync(home, base, ['--check'])
    expect(clean.code, clean.stdout).toBe(0)
  })

  it('--check reports a stale old Codex copy beside a current one as drift', async () => {
    const base = await serve()
    const home = await machine(base)
    await sync(home, base)
    const { writeFile } = await import('node:fs/promises')
    await mkdir(join(home, '.codex/skills/cairn'), { recursive: true })
    await writeFile(join(home, '.codex/skills/cairn/SKILL.md'), 'old')
    const out = await sync(home, base, ['--check'])
    expect(out.code).toBe(1)
    expect(out.stdout).toMatch(/DRIFT\s+\S*\.codex\/skills\/cairn\/SKILL\.md\s+\(superseded/)
  })

  it('--check reports a missing ~/.agents copy as drift', async () => {
    const base = await serve()
    const home = await machine(base)
    await sync(home, base)
    const { rm: remove } = await import('node:fs/promises')
    await remove(join(home, '.agents/skills/cairn/reference.md'))
    const out = await sync(home, base, ['--check'])
    expect(out.code).toBe(1)
    expect(out.stdout).toMatch(/DRIFT\s+\S*\.agents\/skills\/cairn\/reference\.md\s+\(missing\)/)
  })

  it('a home OpenClaw shares keeps Codex at ~/.codex/skills: nothing in ~/.agents, nothing retired', async () => {
    const base = await serve()
    const home = await machine(base)
    const gateway = await temp('cairn-lab-gateway-')
    await mkdir(join(gateway, 'skills/cairn'), { recursive: true })
    const old = join(home, '.codex/skills/cairn')
    await mkdir(old, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(old, 'SKILL.md'), 'old')
    const out = await sync(home, base, ['--also', `skill=${join(gateway, 'skills/cairn/SKILL.md')}`])
    expect(out.code, out.stdout).toBe(0)
    for (const name of ['SKILL.md', 'lab.md', 'reference.md']) {
      expect(existsSync(join(old, name)), name).toBe(true)
    }
    expect(await readFile(join(old, 'SKILL.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/SKILL.md')
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('--runtimes openclaw,codex is the same signal for the sync', async () => {
    const base = await serve()
    const home = await machine(base)
    const out = await sync(home, base, ['--runtimes', 'codex,openclaw'])
    expect(out.code, out.stdout).toBe(0)
    expect(existsSync(join(home, '.codex/skills/cairn/SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('--check reports a missing lab.md as drift', async () => {
    const base = await serve()
    const home = await machine(base)
    await sync(home, base, ['--runtimes', 'claude-code'])
    const { rm: remove } = await import('node:fs/promises')
    await remove(join(home, '.claude/skills/cairn/lab.md'))
    const out = await sync(home, base, ['--runtimes', 'claude-code', '--check'])
    expect(out.code).toBe(1)
    expect(out.stdout).toMatch(/DRIFT\s+\S*skills\/cairn\/lab\.md\s+\(missing\)/)
  })

  it('--check reports a missing reference.md as drift', async () => {
    const base = await serve()
    const home = await machine(base)
    await sync(home, base, ['--runtimes', 'claude-code'])
    const { rm: remove } = await import('node:fs/promises')
    await remove(join(home, '.claude/skills/cairn/reference.md'))
    const out = await sync(home, base, ['--runtimes', 'claude-code', '--check'])
    expect(out.code).toBe(1)
    expect(out.stdout).toMatch(/DRIFT\s+\S*skills\/cairn\/reference\.md\s+\(missing\)/)
  })
})

describe('the skill and the guide point at it, and name nothing else', () => {
  it('SKILL.md says where lab.md is, and the file exists', async () => {
    const skill = await readFile(join(REPO, 'skills/cairn/SKILL.md'), 'utf8')
    expect(skill).toContain('`lab.md`')
    expect(skill).toContain('`reference.md`')
    expect(existsSync(join(REPO, 'skills/cairn/lab.md'))).toBe(true)
    expect(existsSync(join(REPO, 'skills/cairn/reference.md'))).toBe(true)
  })

  it('AGENTS.md points at both documents', async () => {
    const guide = await readFile(join(REPO, 'AGENTS.md'), 'utf8')
    expect(guide).toContain('skills/cairn/lab.md')
    expect(guide).toContain('docs/lab.md')
  })

  it('lab.md teaches what the Lab changes: an idea is a subject, a conclusion closes, todos are tasks, hand-off leaves', async () => {
    const lab = await readFile(join(REPO, 'skills/cairn/lab.md'), 'utf8')
    for (const needle of [
      'An idea is a subject',
      'requires a conclusion',
      '--subject LAB-12',
      'cairn handoff',
      'handed_off',
      'cairn sync',
    ]) {
      expect(lab).toContain(needle)
    }
  })

  it('no other product is named in the Lab\'s documents or the CLI\'s help', async () => {
    const files = ['skills/cairn/lab.md', 'skills/cairn/reference.md', 'skills/cairn/SKILL.md', 'AGENTS.md']
    for (const file of files) {
      expect(await readFile(join(REPO, file), 'utf8'), file).not.toMatch(/croft|trig\b|quarry/i)
    }
    const help = await exec([CLI, '--help'], { ...(process.env as Record<string, string>), HOME: await temp('cairn-help-') })
    expect(help.stdout).not.toMatch(/croft|trig\b|quarry/i)
  })
})
