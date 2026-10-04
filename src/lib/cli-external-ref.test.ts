import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * A task may carry an external ref: where it came from in another tool. The
 * CLI sends it on add and update, filters on it in list, and prints it in show.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method: string; path: string; body: Record<string, unknown> | null }

const serve = (answer: (seen: Seen) => unknown) => {
  const seen: Seen[] = []
  const started = new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        const entry = { method: req.method ?? 'GET', path: req.url ?? '', body: raw ? JSON.parse(raw) : null }
        seen.push(entry)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: answer(entry) }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })
  return { seen, base: () => started }
}

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-external-'))
  directories.push(home)
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: `${base}/`, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

const task = { ref: 'ACME-42', number: 42, title: 'Wire the relay', status: 'backlog', type: 'feature', priority: 'medium' }
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET')

describe('cairn add --external-ref', () => {
  it('sends the ref and the url with the task', async () => {
    const { seen, base } = serve((s) => (s.method === 'POST' ? task : { results: [], tasks: [] }))
    await run(['add', 'Wire the relay', '--project', 'ACME', '--no-start', '--external-ref', 'tracker:host/T-4', '--external-url', 'https://example.test/t/4'], await base())
    const [post] = writes(seen)
    expect(post?.path).toBe('/api/v1/projects/ACME/tasks')
    expect(post?.body).toMatchObject({ title: 'Wire the relay', externalRef: 'tracker:host/T-4', externalUrl: 'https://example.test/t/4' })
  })

  it('sends neither when the flags are absent', async () => {
    const { seen, base } = serve((s) => (s.method === 'POST' ? task : { results: [], tasks: [] }))
    await run(['add', 'Wire the relay', '--project', 'ACME', '--no-start'], await base())
    const body = writes(seen)[0]?.body ?? {}
    expect(body).not.toHaveProperty('externalRef')
    expect(body).not.toHaveProperty('externalUrl')
  })

  it('says so, and claims nothing, when the ref was already filed', async () => {
    const { seen, base } = serve((s) => (s.method === 'POST' ? { ...task, duplicate: true } : { results: [], tasks: [] }))
    const { stdout, stderr, code } = await run(['add', 'Wire the relay', '--project', 'ACME', '--start', '--external-ref', 'X-1'], await base())
    expect(code).toBe(0)
    expect(stderr).toContain('already filed as ACME-42')
    expect(stdout).toContain('duplicate\ttrue')
    expect(writes(seen)).toHaveLength(1)
    expect(seen.some((s) => s.path.endsWith('/claim'))).toBe(false)
  })

  it('refuses an empty ref on add', async () => {
    const { base } = serve(() => ({}))
    const { code, stderr } = await run(['add', 'Wire the relay', '--project', 'ACME', '--external-ref='], await base())
    expect(code).not.toBe(0)
    expect(stderr).toContain('--external-ref')
  })
})

describe('cairn update --external-ref', () => {
  it('sets both', async () => {
    const { seen, base } = serve(() => task)
    await run(['update', 'ACME-42', '--external-ref', 'LEG-9', '--external-url', 'https://example.test/9'], await base())
    expect(seen[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/tasks/ACME-42', body: { externalRef: 'LEG-9', externalUrl: 'https://example.test/9' } })
  })

  it("clears them with '' as a separate argument or with =", async () => {
    const { seen, base } = serve(() => task)
    await run(['update', 'ACME-42', '--external-ref', '', '--external-url='], await base())
    expect(seen[0]?.body).toEqual({ externalRef: null, externalUrl: null })
  })

  it('refuses a bare flag with no value rather than clearing', async () => {
    const { seen, base } = serve(() => task)
    const { code, stderr } = await run(['update', 'ACME-42', '--external-ref'], await base())
    expect(code).not.toBe(0)
    expect(stderr).toContain('needs a value')
    expect(seen).toHaveLength(0)
  })

  it('leaves them out when not given', async () => {
    const { seen, base } = serve(() => task)
    await run(['update', 'ACME-42', '--priority', 'high'], await base())
    expect(seen[0]?.body).toEqual({ priority: 'high' })
  })
})

describe('cairn list --external-ref', () => {
  it('filters exactly, through the query string', async () => {
    const { seen, base } = serve(() => ({ count: 0, offset: 0, limit: 50, tasks: [] }))
    await run(['list', '--project', 'ACME', '--external-ref', 'tracker:host/T-4'], await base())
    expect(new URL(seen[0]!.path, 'http://x').searchParams.get('external_ref')).toBe('tracker:host/T-4')
  })
})

describe('cairn show', () => {
  const digest = { ...task, externalRef: 'LEG-9', externalUrl: 'https://example.test/9' }

  it('prints both in TSV and JSON', async () => {
    const { base } = serve(() => digest)
    const url = await base()
    const tsv = (await run(['show', 'ACME-42'], url)).stdout
    expect(tsv).toContain('externalRef\tLEG-9')
    expect(tsv).toContain('externalUrl\thttps://example.test/9')
    const json = JSON.parse((await run(['show', 'ACME-42', '--json'], url)).stdout)
    expect(json).toMatchObject({ externalRef: 'LEG-9', externalUrl: 'https://example.test/9' })
  })

  it('prints nothing for a task without one', async () => {
    const { base } = serve(() => ({ ...task, externalRef: null, externalUrl: null }))
    expect((await run(['show', 'ACME-42'], await base())).stdout).not.toContain('external')
  })
})
