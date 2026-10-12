import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * CAIRN-390: the scheduled job runs ~/.cairn/maintenance/sync-agent-files.mjs,
 * which never updated itself, so a machine whose copy predated an artefact
 * never learned the artefact existed (lab.md, missing on the Mac from 0.22.0).
 * What is pinned here:
 *
 * - the job replaces its own script from the same tag it syncs everything else
 *   from, and the run that did so still installs what the release added;
 * - a script that does not verify is never written, and the run says so and
 *   exits 1 — while the files it can sync are still synced;
 * - a copy it cannot write is reported the same way;
 * - an unreachable instance among several does not stop any of it.
 *
 * Every write goes to a temporary HOME. The sync has a few targets outside any
 * home (/usr/local/bin/cairn, /opt/cairn-*), which it only updates where they
 * already exist; these cases are skipped on a machine that has any of them.
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

const SYNC_PATH = 'scripts/sync-agent-files.mjs'
const CRON_PATH = 'scripts/install-cron.mjs'

/**
 * The script this release ships and the script the machine has: the same file,
 * less the one artefact the release added. Its own self-update is intact, which
 * is the copy that exists in the field once this change has shipped once.
 */
const RELEASE_SYNC = await readFile(join(REPO, SYNC_PATH), 'utf8')
const RELEASE_CRON = await readFile(join(REPO, CRON_PATH), 'utf8')
const LAB_ENTRY = /\n  \{\n {4}\/\/ The Lab's workflow[\s\S]*?\n {2}\},/
const REFERENCE_ENTRY = /\n  \{\n {4}\/\/ The reference SKILL\.md points at[\s\S]*?\n {2}\},/
const OLD_SYNC = RELEASE_SYNC.replace(LAB_ENTRY, '').replace(REFERENCE_ENTRY, '')

type Mirror = {
  version?: unknown
  status?: number
  /** Replaces what the mirror serves for a path under v<version>/. */
  files?: Record<string, string>
  missing?: string[]
}

/**
 * An instance and a mirror in one: /api/v1/health answers the version, and
 * /raw/v<version>/<file> serves the real maintenance scripts and a marker for
 * every other file, so a copy on disk says exactly which URL it came from.
 */
const serve = (mirror: Mirror) =>
  new Promise<{ base: string; requests: string[] }>((resolve) => {
    const requests: string[] = []
    const server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push(path)
      if (path === '/api/v1/health') {
        res.writeHead(mirror.status ?? 200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ success: true, data: { status: 'ok', version: mirror.version } }))
      }
      const file = /^\/raw\/v[^/]+\/(.+)$/.exec(path)?.[1]
      if (file && !mirror.missing?.includes(file)) {
        res.writeHead(200)
        if (mirror.files?.[file] !== undefined) return res.end(mirror.files[file])
        if (file === SYNC_PATH) return res.end(RELEASE_SYNC)
        if (file === CRON_PATH) return res.end(RELEASE_CRON)
        return res.end(`pinned:${path}`)
      }
      res.writeHead(404)
      res.end('not found')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests })
    })
  })

/**
 * A machine whose maintenance copy predates the lab artefact: Claude Code with
 * a skill installed, a CLI, and the old script at its default path.
 */
const machine = async (instances: Record<string, string>) => {
  const home = await temp('cairn-selfsync-home-')
  await mkdir(join(home, '.claude/skills/cairn'), { recursive: true })
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await mkdir(join(home, '.cairn/maintenance'), { recursive: true })
  await writeFile(join(home, '.claude/skills/cairn/SKILL.md'), 'old skill')
  await writeFile(join(home, '.local/bin/cairn'), 'old cli')
  await writeFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), OLD_SYNC, { mode: 0o755 })
  await writeFile(join(home, '.cairn/maintenance/install-cron.mjs'), 'old installer', { mode: 0o755 })
  await chmod(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 0o755)
  await writeFile(
    join(home, '.cairn/instances.json'),
    JSON.stringify({
      version: 1,
      instances: Object.fromEntries(Object.entries(instances).map(([name, url]) => [name, { url }])),
      unclassified: { mode: 'ask' },
    }),
  )
  return home
}

/** Run the machine's own copy, as the scheduler does. */
const job = (home: string, base: string, extra: string[] = [], env: Record<string, string> = {}) =>
  run(
    process.execPath,
    [join(home, '.cairn/maintenance/sync-agent-files.mjs'), '--source', 'release', '--repo', `${base}/raw`, ...extra],
    { PATH: BASE_PATH, HOME: home, CAIRN_SYNC_RETRY_MS: '0', ...env },
  )

const copy = (home: string) => join(home, '.cairn/maintenance/sync-agent-files.mjs')
const lab = (home: string) => join(home, '.claude/skills/cairn/lab.md')
const reference = (home: string) => join(home, '.claude/skills/cairn/reference.md')

describe.skipIf(SYSTEM_TARGETS)('agent-files updates its own script (CAIRN-390)', () => {
  it('fixture: the old copy really does not know the lab artefact', () => {
    expect(RELEASE_SYNC).toContain("file: 'skills/cairn/lab.md'")
    expect(OLD_SYNC).not.toContain("file: 'skills/cairn/lab.md'")
    expect(RELEASE_SYNC).toContain("file: 'skills/cairn/reference.md'")
    expect(OLD_SYNC).not.toContain("file: 'skills/cairn/reference.md'")
    expect(OLD_SYNC).toContain('CAIRN_SYNC_REEXEC')
  })

  it('replaces the script and, in the same run, installs the artefact the release added', async () => {
    const { base, requests } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })
    expect(existsSync(lab(home))).toBe(false)

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(copy(home), 'utf8')).toBe(RELEASE_SYNC)
    expect(await readFile(join(home, '.cairn/maintenance/install-cron.mjs'), 'utf8')).toBe(RELEASE_CRON)
    expect(await readFile(lab(home), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/lab.md')
    expect(await readFile(reference(home), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/reference.md')
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
    expect(result.stdout).toContain('re-running')
    // The updated copy was handed the tag the first run resolved, not asked again.
    expect(requests.filter((path) => path === '/api/v1/health')).toHaveLength(1)
    expect(requests.every((path) => path === '/api/v1/health' || path.startsWith('/raw/v1.2.3/'))).toBe(true)
  })

  it('keeps the script executable and leaves no temporary file beside it', async () => {
    const { base } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })
    await chmod(copy(home), 0o750)

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(0)
    expect((await stat(copy(home))).mode & 0o777).toBe(0o750)
    expect((await stat(join(home, '.cairn/maintenance/install-cron.mjs'))).mode & 0o777).toBe(0o755)
    expect((await readdir(join(home, '.cairn/maintenance'))).sort()).toEqual(['install-cron.mjs', 'sync-agent-files.mjs'])
  })

  it('does nothing further once both the script and the artefacts are current', async () => {
    const { base } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })
    await job(home, base)

    const second = await job(home, base)

    expect(second.code, second.stdout).toBe(0)
    expect(second.stdout).not.toContain('re-running')
    expect(second.stdout).not.toMatch(/^\s+updated /m)
  })

  it('does not run itself again from an updated copy: one swap per run', async () => {
    const { base, requests } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })

    const result = await job(home, base, [], { CAIRN_SYNC_REEXEC: '1' })

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).not.toContain('re-running')
    expect(result.stdout).toContain('refreshed by the run that started this one')
    expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
    expect(requests.some((path) => path.includes('scripts/'))).toBe(false)
  })

  it('reports a script that does not parse, keeps the old one, and still syncs the rest', async () => {
    const broken = '#!/usr/bin/env node\nconst = 1\n'
    const { base } = await serve({ version: '1.2.3', files: { [SYNC_PATH]: broken } })
    const home = await machine({ personal: base })

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toContain('SELF-UPDATE FAILED')
    expect(result.stdout).toMatch(/maintenance: scripts\/sync-agent-files\.mjs from .* does not parse/)
    expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
    expect(existsSync(lab(home))).toBe(false)
    expect(result.stdout).not.toContain('re-running')
    // What the old script knows is still current: the failure does not make a stale machine staler.
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
    expect(await readFile(join(home, '.claude/skills/cairn/SKILL.md'), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/SKILL.md')
  })

  it.each([
    ['an HTML page a mirror served with a 200', '<!doctype html><title>Not found</title>'],
    ['an empty body', ''],
    ['a file that is not a node script', 'pinned:not a script\n'],
  ])('refuses %s in place of the script', async (_, body) => {
    const { base } = await serve({ version: '1.2.3', files: { [SYNC_PATH]: body } })
    const home = await machine({ personal: base })

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toContain('SELF-UPDATE FAILED')
    expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
  })

  it('reports a script the release does not have, rather than carrying on silently', async () => {
    const { base } = await serve({ version: '1.2.3', missing: [SYNC_PATH] })
    const home = await machine({ personal: base })

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toMatch(/SELF-UPDATE FAILED[\s\S]*sync-agent-files\.mjs could not be read from .*returned 404/)
    expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('pinned:/raw/v1.2.3/cli/cairn.mjs')
  })

  it('still refuses the whole run, writing nothing, when a data file is missing', async () => {
    const { base } = await serve({ version: '1.2.3', missing: ['mcp/server.mjs'] })
    const home = await machine({ personal: base })

    const result = await job(home, base)

    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toContain('NOT SYNCED')
    expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
    expect(await readFile(join(home, '.local/bin/cairn'), 'utf8')).toBe('old cli')
  })

  it.skipIf(process.getuid?.() === 0)('reports a copy it cannot write, and the exit status says so', async () => {
    const { base } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })
    // Neither the file nor its directory can be written: what a root-owned copy looks like to a user.
    await chmod(copy(home), 0o555)
    await chmod(join(home, '.cairn/maintenance'), 0o555)
    try {
      const result = await job(home, base)

      expect(result.code, result.stdout).toBe(1)
      expect(result.stdout).toContain('SELF-UPDATE FAILED')
      expect(result.stdout).toMatch(/was not replaced at .*sync-agent-files\.mjs/)
      expect(await readFile(copy(home), 'utf8')).toBe(OLD_SYNC)
    } finally {
      await chmod(join(home, '.cairn/maintenance'), 0o755)
    }
  })

  it('serves every instance: the newest release wins, and one that cannot be asked is left out', async () => {
    const personal = await serve({ version: '1.2.3' })
    const croft = await serve({ version: '1.2.4' })
    const dispofi = await serve({ status: 503, version: '9.9.9' })
    const home = await machine({ personal: personal.base, croft: croft.base, dispofi: dispofi.base })

    const result = await job(home, personal.base)

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toMatch(/skipped {3}dispofi: .*answered 503/)
    expect(result.stdout).toContain('release   v1.2.4')
    expect(await readFile(copy(home), 'utf8')).toBe(RELEASE_SYNC)
    expect(await readFile(lab(home), 'utf8')).toBe('pinned:/raw/v1.2.4/skills/cairn/lab.md')
  })

  it('does not follow an instance that refuses connections: the others carry the run', async () => {
    const personal = await serve({ version: '1.2.3' })
    const gone = await serve({ version: '9.9.9' })
    const goneBase = gone.base
    await new Promise((done) => servers.splice(servers.length - 1).forEach((s) => s.close(done)))
    const home = await machine({ personal: personal.base, dispofi: goneBase })

    const result = await job(home, personal.base)

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toMatch(/skipped {3}dispofi: could not ask/)
    expect(await readFile(copy(home), 'utf8')).toBe(RELEASE_SYNC)
    expect(await readFile(lab(home), 'utf8')).toBe('pinned:/raw/v1.2.3/skills/cairn/lab.md')
  })

  it('does not replace a checkout it was run from, only the installed copies', async () => {
    const { base } = await serve({ version: '1.2.3' })
    const home = await machine({ personal: base })
    const before = await readFile(join(REPO, SYNC_PATH), 'utf8')

    const result = await run(
      process.execPath,
      [join(REPO, SYNC_PATH), '--source', 'release', '--repo', `${base}/raw`],
      { PATH: BASE_PATH, HOME: home, CAIRN_SYNC_RETRY_MS: '0' },
    )

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(REPO, SYNC_PATH), 'utf8')).toBe(before)
    expect(await readFile(copy(home), 'utf8')).toBe(RELEASE_SYNC)
    expect(result.stdout).not.toContain('re-running')
  })
})
