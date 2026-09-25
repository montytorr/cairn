import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `reconcile` and `vitals` belong to an instance, not a directory, and run
 * from a scheduler at `/` (CAIRN-301). `--all-instances` runs them once per
 * instance, each under that instance's own maintenance key.
 */
const cli = join(process.cwd(), 'cli', 'cairn.mjs')

type Seen = { auth?: string; path?: string; body?: string }[]

const VITALS = {
  windowHours: 24,
  findings: [{ code: 'x', severity: 'warning', message: 'something is off' }],
  sessions: { recent: 0, recentWithFiles: 0 },
  tasks: { opened: 0, closed: 0, stalled: 0 },
  autoReleased: 0,
}

const serve = (seen: Seen) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url === '/api/v1/projects?archived=1') {
          res.end(JSON.stringify({ success: true, data: [] }))
          return
        }
        seen.push({ auth: req.headers.authorization, path: req.url, ...(body ? { body } : {}) })
        const data = req.url?.startsWith('/api/v1/vitals') ? VITALS : { released: [] }
        res.end(JSON.stringify({ success: true, data }))
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }))
  })

describe('maintenance on a machine with several instances', () => {
  let home: string
  const servers: Server[] = []
  let a: string
  let b: string
  const seenA: Seen = []
  const seenB: Seen = []

  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const merged: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        CAIRN_AGENT: 'maintenance',
        CAIRN_DEADLINE_MS: '2000',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      }
      for (const k of ['CAIRN_BASE_URL', 'CAIRN_API_KEY', 'CAIRN_INSTANCE']) delete merged[k]
      Object.assign(merged, env)
      // A scheduler's directory: nothing to route by.
      const child = spawn(process.execPath, [cli, ...args], { cwd: '/', env: merged as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })

  const configure = async (keys: Record<string, string>) => {
    await writeFile(join(home, '.cairn', 'instances.json'), JSON.stringify({
      version: 1, instances: { personal: { url: a }, work: { url: b } }, unclassified: { mode: 'ask' },
    }))
    for (const [name, env] of Object.entries(keys)) {
      await mkdir(join(home, '.cairn', 'instances', name), { recursive: true })
      await writeFile(join(home, '.cairn', 'instances', name, 'env'), env)
    }
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cairn-maint-'))
    await mkdir(join(home, '.cairn'), { recursive: true })
    seenA.length = 0
    seenB.length = 0
    const first = await serve(seenA)
    const second = await serve(seenB)
    servers.push(first.server, second.server)
    a = first.url
    b = second.url
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
    await rm(home, { recursive: true, force: true })
  })

  it('reconciles every instance with its own maintenance key', async () => {
    await configure({
      personal: 'CAIRN_API_KEY_MAINTENANCE=crn_maint_personal\n',
      work: 'CAIRN_API_KEY_MAINTENANCE=crn_maint_work\n',
    })
    const result = await run(['reconcile', '--all-instances'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('== instance personal ==')
    expect(result.stdout).toContain('== instance work ==')
    expect(seenA).toMatchObject([{ auth: 'Bearer crn_maint_personal', path: '/api/v1/reconcile' }])
    expect(seenB).toMatchObject([{ auth: 'Bearer crn_maint_work', path: '/api/v1/reconcile' }])
  })

  it('still runs the others when one instance fails, and exits non-zero', async () => {
    await configure({ personal: 'CAIRN_API_KEY_MAINTENANCE=crn_maint_personal\n', work: 'CAIRN_API_KEY_CODEX=crn_codex\n' })
    const result = await run(['reconcile', '--all-instances'])

    expect(result.code).toBe(1)
    expect(seenA).toHaveLength(1)
    expect(seenB).toHaveLength(0)
    expect(result.stderr).toContain('reconcile on instance work failed')
  })

  it('refuses a --notify that does not say which instance the task is on', async () => {
    await configure({ personal: 'CAIRN_API_KEY_MAINTENANCE=m\n', work: 'CAIRN_API_KEY_MAINTENANCE=m\n' })
    const result = await run(['vitals', '--all-instances', '--notify', 'CAIRN-107'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--notify <instance>:CAIRN-107')
    expect(seenA.length + seenB.length).toBe(0)
  })

  it('is only for the commands about an instance', async () => {
    await configure({ personal: 'CAIRN_API_KEY_MAINTENANCE=m\n' })
    const result = await run(['note', 'ACME-1', 'x', '--all-instances'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--all-instances is for reconcile and vitals')
  })

  const both = {
    personal: 'CAIRN_API_KEY_MAINTENANCE=crn_maint_personal\n',
    work: 'CAIRN_API_KEY_MAINTENANCE=crn_maint_work\n',
  }

  it("posts each instance's vitals to its own task, and skips an instance with no entry", async () => {
    await configure(both)
    const result = await run(['vitals', '--all-instances', '--notify', 'work:OPS-3'])
    expect(result.code).toBe(0)
    expect(seenA.map((r) => r.path)).toEqual(['/api/v1/vitals?hours=24'])
    expect(seenB.map((r) => r.path)).toEqual(['/api/v1/vitals?hours=24', '/api/v1/tasks/OPS-3/notes'])

    seenA.length = 0
    seenB.length = 0
    await run(['vitals', '--all-instances', '--notify', 'personal:CAIRN-107,work:OPS-3'])
    expect(seenA.at(-1)?.path).toBe('/api/v1/tasks/CAIRN-107/notes')
    expect(seenB.at(-1)?.path).toBe('/api/v1/tasks/OPS-3/notes')
  })

  it('reads instance:REF on a single vitals run too, and refuses a list that leaves this instance out', async () => {
    await configure(both)
    expect((await run(['vitals', '--instance', 'work', '--notify', 'personal:CAIRN-1,work:OPS-3'])).code).toBe(0)
    expect(seenB.at(-1)?.path).toBe('/api/v1/tasks/OPS-3/notes')

    const missing = await run(['vitals', '--instance', 'work', '--notify', 'personal:CAIRN-1'])
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('no entry for instance work')
  })

  it('refuses a bare --notify, and --instance beside --all-instances', async () => {
    await configure(both)
    const bare = await run(['vitals', '--all-instances', '--notify'])
    expect(bare.code).not.toBe(0)
    expect(bare.stderr).toContain('--notify needs the task')
    const both2 = await run(['reconcile', '--all-instances', '--instance', 'work'])
    expect(both2.code).not.toBe(0)
    expect(both2.stderr).toContain('contradict')
    expect(seenA.length + seenB.length).toBe(0)
  })

  /** Only vitals reports; reconcile must still say that --notify does nothing for it. */
  it('still reports --notify as ignored on reconcile', async () => {
    await configure(both)
    const result = await run(['reconcile', '--instance', 'work', '--notify', 'work:OPS-3'])
    expect(result.stderr).toContain('`reconcile` does not take --notify')
  })

  it('gives one JSON document keyed by instance', async () => {
    await configure(both)
    const result = await run(['reconcile', '--all-instances', '--json'])
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(Object.keys(parsed.instances)).toEqual(['personal', 'work'])
    expect(parsed.instances.work).toMatchObject({ count: 0 })
  })

  it('changes nothing on a machine with one instance', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY_MAINTENANCE=crn_maint\n`)
    const result = await run(['reconcile', '--all-instances'])
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('== instance')
    expect(seenA).toMatchObject([{ auth: 'Bearer crn_maint', path: '/api/v1/reconcile' }])
  })
})
