import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Several Cairn instances on one machine (CAIRN-299). The property every test
 * here defends is the same one: a command reaches the instance it was told
 * to, with that instance's key, or it reaches nothing at all.
 */
const cli = join(process.cwd(), 'cli', 'cairn.mjs')

type Seen = { auth?: string; path?: string; body?: string }[]

/**
 * The routing cache refresh (`GET /api/v1/projects?archived=1`) is answered
 * with `projects` and kept out of `seen`, so each test counts the commands it
 * ran and nothing else.
 */
const serve = (seen: Seen, status = 200, projects: string[] = []) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.method === 'GET' && req.url === '/api/v1/projects?archived=1') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: projects.map((key) => ({ key, former_keys: [] })) }))
          return
        }
        seen.push({ auth: req.headers.authorization, path: req.url, body })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200
          ? { success: true, data: { id: 1, results: [], count: 0 } }
          : { success: false, error: 'offline' }))
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }))
  })

describe('several instances on one machine', () => {
  let home: string
  const servers: Server[] = []
  let a: string
  let b: string
  const seenA: Seen = []
  const seenB: Seen = []

  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const merged: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        CAIRN_AGENT: 'claude-code',
        CAIRN_DEADLINE_MS: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        ...env,
      }
      delete merged.CAIRN_BASE_URL
      delete merged.CAIRN_API_KEY
      delete merged.CAIRN_INSTANCE
      for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: home,
        env: merged as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })

  const configure = async (unclassified: object = { mode: 'ask' }) => {
    await writeFile(join(home, '.cairn', 'instances.json'), JSON.stringify({
      version: 1,
      instances: { personal: { url: a }, work: { url: `${b}/` } },
      unclassified,
    }))
    for (const [name, key] of [['personal', 'crn_personal'], ['work', 'crn_work']] as const) {
      await mkdir(join(home, '.cairn', 'instances', name), { recursive: true })
      await writeFile(join(home, '.cairn', 'instances', name, 'env'), `CAIRN_API_KEY_CLAUDE_CODE=${key}\n`)
    }
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cairn-instances-'))
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

  it('sends each command to the instance it names, with that instance\'s key', async () => {
    await configure()
    expect((await run(['note', 'ACME-1', 'personal note', '--instance', 'personal'])).code).toBe(0)
    expect((await run(['note', 'ACME-1', 'work note', '--instance=work'])).code).toBe(0)

    expect(seenA.map((r) => r.auth)).toEqual(['Bearer crn_personal'])
    expect(seenB.map((r) => r.auth)).toEqual(['Bearer crn_work'])
  })

  it('takes the instance from CAIRN_INSTANCE, which is how a hook passes it', async () => {
    await configure()
    expect((await run(['note', 'ACME-1', 'x'], { CAIRN_INSTANCE: 'work' })).code).toBe(0)
    expect(seenA).toHaveLength(0)
    expect(seenB).toHaveLength(1)
  })

  it('stops with exit 10 and contacts nothing when no instance is chosen and the machine asks', async () => {
    await configure({ mode: 'ask' })
    const result = await run(['note', 'ACME-1', 'x'])

    expect(result.code).toBe(10)
    expect(result.stderr).toContain('Ask the user which one')
    expect(result.stderr).toContain('personal, work')
    expect(seenA).toHaveLength(0)
    expect(seenB).toHaveLength(0)
  })

  it('uses the default instance when one is configured', async () => {
    await configure({ mode: 'default', instance: 'work' })
    expect((await run(['note', 'ACME-1', 'x'])).code).toBe(0)
    expect(seenB).toHaveLength(1)
    expect(seenA).toHaveLength(0)
  })

  it('refuses a key from the environment, which cannot say which instance issued it', async () => {
    await configure({ mode: 'default', instance: 'work' })
    const result = await run(['note', 'ACME-1', 'x'], { CAIRN_API_KEY: 'crn_from_env' })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('CAIRN_API_KEY is set in the environment')
    expect(seenA.length + seenB.length).toBe(0)
  })

  it('refuses a CAIRN_BASE_URL that disagrees with the chosen instance, and accepts one that agrees', async () => {
    await configure()
    const wrong = await run(['note', 'ACME-1', 'x', '--instance', 'work'], { CAIRN_BASE_URL: a })
    expect(wrong.code).toBe(2)
    expect(wrong.stderr).toContain('different server than instance "work"')
    expect(seenA.length + seenB.length).toBe(0)

    const same = await run(['note', 'ACME-1', 'x', '--instance', 'work'], { CAIRN_BASE_URL: `${b}/` })
    expect(same.code).toBe(0)
    expect(seenB).toHaveLength(1)
  })

  it('refuses an instance that is not configured, and --instance on a one-instance machine', async () => {
    await configure()
    const unknown = await run(['note', 'ACME-1', 'x', '--instance', 'client'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('no instance named "client"')

    await rm(join(home, '.cairn', 'instances.json'))
    const single = await run(['note', 'ACME-1', 'x', '--instance', 'work'], { CAIRN_BASE_URL: a, CAIRN_API_KEY: 'k' })
    expect(single.code).toBe(2)
    expect(single.stderr).toContain('has one instance')
    expect(seenA.length + seenB.length).toBe(0)
  })

  it('refuses a malformed instances.json instead of falling back to ~/.cairn/env', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY=crn_legacy\n`)
    await writeFile(join(home, '.cairn', 'instances.json'), '{"version": 1, "instances": {}}')
    const result = await run(['note', 'ACME-1', 'x'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('must name at least one instance')
    expect(seenA).toHaveLength(0)
  })

  it('queues a write in the chosen instance\'s own outbox', async () => {
    const down: Seen = []
    const offline = await serve(down, 503)
    servers.push(offline.server)
    await writeFile(join(home, '.cairn', 'instances.json'), JSON.stringify({
      version: 1, instances: { work: { url: offline.url } }, unclassified: { mode: 'default', instance: 'work' },
    }))
    await mkdir(join(home, '.cairn', 'instances', 'work'), { recursive: true })
    await writeFile(join(home, '.cairn', 'instances', 'work', 'env'), 'CAIRN_API_KEY_CLAUDE_CODE=crn_work\n')

    const result = await run(['note', 'ACME-1', 'queued'])
    expect(result.stderr).toContain('queued locally')
    expect(existsSync(join(home, '.cairn', 'instances', 'work', 'outbox.jsonl'))).toBe(true)
    expect(existsSync(join(home, '.cairn', 'outbox.jsonl'))).toBe(false)
  })

  it('tags the breadcrumb the session-end hook reads with the instance', async () => {
    await configure()
    await run(['note', 'ACME-1', 'x', '--instance', 'work'])
    const acted = (await readFile(join(home, '.cairn', 'acted.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(acted.at(-1)).toMatchObject({ ref: 'ACME-1', instance: 'work' })
  })

  it('adds an instance and adopts this machine\'s existing files into it', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY_CLAUDE_CODE=crn_personal\n`)
    await writeFile(join(home, '.cairn', 'projects.json'), '{"/x":"ACME"}')
    await mkdir(join(home, '.cairn', 'ownership'))
    await writeFile(join(home, '.cairn', 'outbox.jsonl'), '')

    const added = await run(['instance', 'add', 'personal', '--url', a, '--default', '--adopt'])
    expect(added.code).toBe(0)
    expect(added.stdout).toContain('instance personal')
    const dir = join(home, '.cairn', 'instances', 'personal')
    for (const file of ['env', 'projects.json', 'ownership', 'outbox.jsonl']) {
      expect(existsSync(join(dir, file))).toBe(true)
      expect(existsSync(join(home, '.cairn', file))).toBe(false)
    }
    expect(((await stat(join(home, '.cairn', 'instances.json'))).mode & 0o777).toString(8)).toBe('600')

    expect((await run(['note', 'ACME-1', 'after adoption'])).code).toBe(0)
    expect(seenA.map((r) => r.auth)).toEqual(['Bearer crn_personal'])
  })

  it('refuses to adopt files that belong to a different server', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY=crn_personal\n`)
    const result = await run(['instance', 'add', 'work', '--url', b, '--adopt'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('wrong instance')
    expect(existsSync(join(home, '.cairn', 'env'))).toBe(true)
    expect(existsSync(join(home, '.cairn', 'instances.json'))).toBe(false)
  })

  it('lists instances without ever printing a key', async () => {
    await configure({ mode: 'default', instance: 'personal' })
    const list = await run(['instance', 'list'])
    expect(list.code).toBe(0)
    expect(list.stdout).toContain('personal')
    expect(list.stdout).toContain('work')
    expect(list.stdout).not.toContain('crn_')

    const shown = await run(['instance', '--instance', 'work'])
    expect(shown.stdout).toContain('work')
    expect(shown.stdout).not.toContain('crn_')
  })

  /** On a machine with a default, reading a bare --instance as "none" would write to the default. */
  it('refuses --instance with no name instead of falling back to the default', async () => {
    await configure({ mode: 'default', instance: 'personal' })
    for (const args of [['note', 'ACME-1', 'x', '--instance'], ['note', 'ACME-1', 'x', '--instance', '--json'], ['note', 'ACME-1', 'x', '--instance=']]) {
      const result = await run(args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('--instance needs the name of an instance')
    }
    expect(seenA.length + seenB.length).toBe(0)
  })

  it('takes the last --instance, as the parser does for every other flag', async () => {
    await configure()
    expect((await run(['note', 'ACME-1', 'x', '--instance', 'personal', '--instance', 'work'])).code).toBe(0)
    expect(seenB).toHaveLength(1)
    expect(seenA).toHaveLength(0)
  })

  it('refuses to adopt when the existing setup reached another server through CAIRN_BASE_URL', async () => {
    await writeFile(join(home, '.cairn', 'env'), 'CAIRN_API_KEY=crn_work\n')
    const result = await run(['instance', 'add', 'personal', '--url', a, '--adopt'], { CAIRN_BASE_URL: b })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('wrong instance')
    expect(existsSync(join(home, '.cairn', 'env'))).toBe(true)
  })

  it('refuses to adopt keys that were only ever used with localhost into a remote instance', async () => {
    await writeFile(join(home, '.cairn', 'env'), 'CAIRN_API_KEY=crn_local\n')
    const result = await run(['instance', 'add', 'personal', '--url', a, '--adopt'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('http://localhost:3000')
  })

  it('finishes an interrupted adoption on a re-run without losing writes already moved', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY_CLAUDE_CODE=crn_personal\n`)
    const dir = join(home, '.cairn', 'instances', 'personal')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'outbox.jsonl'), '{"id":"moved-before-the-crash"}\n')
    await writeFile(join(home, '.cairn', 'outbox.jsonl'), '{"id":"still-at-the-top"}\n')

    const result = await run(['instance', 'add', 'personal', '--url', a, '--adopt'])
    expect(result.code).toBe(0)
    const outbox = await readFile(join(dir, 'outbox.jsonl'), 'utf8')
    expect(outbox).toContain('moved-before-the-crash')
    expect(outbox).toContain('still-at-the-top')
    expect(existsSync(join(home, '.cairn', 'outbox.jsonl'))).toBe(false)
  })

  it('adds a first instance on a machine with nothing to adopt', async () => {
    await rm(join(home, '.cairn'), { recursive: true })
    const result = await run(['instance', 'add', 'work', '--url', b, '--adopt'])
    expect(result.code).toBe(0)
    expect(existsSync(join(home, '.cairn', 'instances.json'))).toBe(true)
  })

  it('says what is wrong with the configuration on --version too, and still answers locally', async () => {
    await configure()
    const result = await run(['--version', '--instance', 'client'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('cairn ')
    expect(result.stderr).toContain('no instance named "client"')
    expect(seenA.length + seenB.length).toBe(0)
  })

  it.each([
    ['not JSON', '{', 'not valid JSON'],
    ['a wrong version', JSON.stringify({ version: 2, instances: { a: { url: 'https://x' } } }), '"version" must be 1'],
    ['a bad name', JSON.stringify({ version: 1, instances: { Work: { url: 'https://x' } } }), 'not an instance name'],
    ['no url', JSON.stringify({ version: 1, instances: { work: {} } }), 'needs an http(s) "url"'],
    ['a default that is not an instance', JSON.stringify({ version: 1, instances: { work: { url: 'https://x' } }, unclassified: { mode: 'default', instance: 'home' } }), '"unclassified" must be'],
  ])('refuses an instances.json with %s', async (_label, content, message) => {
    await writeFile(join(home, '.cairn', 'instances.json'), content)
    const result = await run(['note', 'ACME-1', 'x'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
  })

  it('keeps saved routes when another instance is added', async () => {
    await configure()
    const cfgPath = join(home, '.cairn', 'instances.json')
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
    await writeFile(cfgPath, JSON.stringify({ ...cfg, routes: [{ path: '/srv/client', match: 'exact', instance: 'work' }] }))

    expect((await run(['instance', 'add', 'lab', '--url', 'https://lab.example'])).code).toBe(0)
    const after = JSON.parse(await readFile(cfgPath, 'utf8'))
    expect(after.routes).toEqual([{ path: '/srv/client', match: 'exact', instance: 'work' }])
    expect(Object.keys(after.instances)).toEqual(['personal', 'work', 'lab'])
  })

  it('sets what an unrouted directory does with instance policy', async () => {
    await configure()
    const cfgPath = join(home, '.cairn', 'instances.json')

    expect((await run(['instance', 'policy', 'default', 'work'])).code).toBe(0)
    expect(JSON.parse(await readFile(cfgPath, 'utf8')).unclassified).toEqual({ mode: 'default', instance: 'work' })
    expect((await run(['note', 'ACME-1', 'x'])).code).toBe(0)
    expect(seenB).toHaveLength(1)

    expect((await run(['instance', 'policy', 'ask'])).code).toBe(0)
    expect((await run(['note', 'ACME-1', 'x'])).code).toBe(10)

    const bad = await run(['instance', 'policy', 'default', 'client'])
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain('personal|work')
  })

  it('leaves the choice open, and says how to make it, when a second instance is added outside a terminal', async () => {
    expect((await run(['instance', 'add', 'personal', '--url', a])).code).toBe(0)
    const second = await run(['instance', 'add', 'work', '--url', b])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('cairn instance policy default <name>')
    expect(JSON.parse(await readFile(join(home, '.cairn', 'instances.json'), 'utf8')).unclassified).toBeUndefined()
  })

  /** The policy was written; exiting 2 would tell a caller it was not. */
  it('warns rather than failing when a local write ignored a flag', async () => {
    await configure()
    const result = await run(['instance', 'policy', 'ask', '--priority', 'high'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('does not take --priority')
    expect(result.stderr).toContain('went through WITHOUT it')
  })

  it('changes nothing on a machine with no instances.json', async () => {
    await writeFile(join(home, '.cairn', 'env'), `CAIRN_BASE_URL=${a}\nCAIRN_API_KEY=crn_legacy\n`)
    expect((await run(['note', 'ACME-1', 'x'])).code).toBe(0)
    expect(seenA.map((r) => r.auth)).toEqual(['Bearer crn_legacy'])
  })
})
