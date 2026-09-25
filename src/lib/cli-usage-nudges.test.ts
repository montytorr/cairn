import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The nudges CAIRN-294 added to the verbs agents actually type: `add` claims
 * for a runtime, `done` says what it recorded and when nobody could see the
 * work, `note` points a dead end at --kind attempt, and the briefing carries
 * the rules. Each asserts what reached the wire as well as what was said,
 * because a hint that changed the stored data would be a different feature.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method: string; path: string; body?: Record<string, unknown> }
type Reply = (req: Seen) => unknown

const serve = (reply: Reply, seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method ?? '', path: req.url ?? '' }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: reply(entry) }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const RUNTIME_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CAIRN_AGENT$|CAIRN_SESSION_ID$)/

const run = async (args: string[], base: string, agent?: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-nudge-'))
  directories.push(home)
  // The suite itself usually runs inside Claude Code, so the runtime markers
  // it inherits would make every case an agent case.
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (RUNTIME_MARKERS.test(name)) delete env[name]
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key', ...(agent ? { CAIRN_AGENT: agent } : {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const created = { ref: 'ACME-7', number: 7, title: 'Wire the relay', status: 'backlog' }

const addServer = ({ similar = [] as unknown[], held = [] as unknown[] } = {}): Reply => (req) => {
  if (req.path.startsWith('/api/v1/search')) return { results: similar }
  if (req.path.includes('/tasks?mine=true')) return { tasks: held, count: held.length }
  if (req.method === 'POST' && req.path.endsWith('/claim')) return { status: 'doing', claimed_by: 'codex · a@b' }
  if (req.method === 'POST') return created
  return {}
}

const claims = (seen: Seen[]) => seen.filter((s) => s.method === 'POST' && s.path.endsWith('/claim'))

describe('cairn add, for an agent runtime', () => {
  it('claims what it files', async () => {
    const seen: Seen[] = []
    const base = await serve(addServer(), seen)
    const { code, stdout, stderr } = await run(['add', 'Wire the relay', '--project', 'ACME'], base, 'codex')
    expect(code).toBe(0)
    expect(claims(seen)).toHaveLength(1)
    expect(stdout).toContain('status\tdoing')
    expect(stderr).toContain('claimed ACME-7')
  })

  it('only files it with --no-start', async () => {
    const seen: Seen[] = []
    const base = await serve(addServer(), seen)
    const { code } = await run(['add', 'Wire the relay', '--project', 'ACME', '--no-start'], base, 'codex')
    expect(code).toBe(0)
    expect(claims(seen)).toHaveLength(0)
  })

  it('files but does not claim when similar open work exists, and says so', async () => {
    const seen: Seen[] = []
    const similar = [{ ref: 'ACME-3', status: 'doing', title: 'Wire the relay to the gateway' }]
    const base = await serve(addServer({ similar }), seen)
    const { code, stderr } = await run(['add', 'Wire the relay', '--project', 'ACME'], base, 'claude-code')
    expect(code).toBe(0)
    expect(seen.some((s) => s.method === 'POST' && s.path.endsWith('/projects/ACME/tasks'))).toBe(true)
    expect(claims(seen)).toHaveLength(0)
    expect(stderr).toContain('similar existing work:')
    expect(stderr).toContain('NOT CLAIMED: ACME-3')
  })

  it('still claims when the only overlap is a loose word or closed work', async () => {
    const seen: Seen[] = []
    const similar = [
      { ref: 'ACME-2', status: 'todo', title: 'Relay logs are noisy' },
      { ref: 'ACME-1', status: 'done', title: 'Wire the relay' },
    ]
    const base = await serve(addServer({ similar }), seen)
    await run(['add', 'Wire the relay', '--project', 'ACME'], base, 'codex')
    expect(claims(seen)).toHaveLength(1)
  })

  it('does not claim a follow-up filed while this session holds work here', async () => {
    const seen: Seen[] = []
    const held = [{ number: 5, status: 'doing', claimed_by: 'codex · a@b', project: { key: 'ACME' } }]
    const base = await serve(addServer({ held }), seen)
    const { stderr } = await run(['add', 'Wire the relay', '--project', 'ACME'], base, 'codex')
    expect(claims(seen)).toHaveLength(0)
    expect(stderr).toContain('you already hold ACME-5')
  })

  it('does not claim when --status says where the task goes', async () => {
    const seen: Seen[] = []
    const base = await serve(addServer(), seen)
    await run(['add', 'Wire the relay', '--project', 'ACME', '--status', 'todo'], base, 'codex')
    expect(claims(seen)).toHaveLength(0)
  })

  it('--start still claims over similar open work, because it was asked for', async () => {
    const seen: Seen[] = []
    const similar = [{ ref: 'ACME-3', status: 'doing', title: 'Wire the relay to the gateway' }]
    const base = await serve(addServer({ similar }), seen)
    await run(['add', 'Wire the relay', '--project', 'ACME', '--start'], base, 'codex')
    expect(claims(seen)).toHaveLength(1)
  })
})

describe('cairn add, for a person', () => {
  it('files without claiming, exactly as before', async () => {
    const seen: Seen[] = []
    const base = await serve(addServer(), seen)
    const { code, stderr } = await run(['add', 'Wire the relay', '--project', 'ACME'], base)
    expect(code).toBe(0)
    expect(claims(seen)).toHaveLength(0)
    expect(seen.some((s) => s.path.includes('mine=true'))).toBe(false)
    expect(stderr).not.toContain('claim')
  })

  it('accepts --no-start without complaint', async () => {
    const seen: Seen[] = []
    const base = await serve(addServer(), seen)
    const { code, stderr } = await run(['add', 'Wire the relay', '--project', 'ACME', '--no-start'], base)
    expect(code).toBe(0)
    expect(stderr).not.toContain('ignored')
  })
})

const closeServer = (activity: unknown[]): Reply => (req) => {
  if (req.method === 'PATCH') return { id: 't', number: 7, status: 'done', resolution: 'x', resolution_kind: 'fixed' }
  if (req.path.includes('/activity')) return activity
  return {}
}

const CLOSE_ONLY = [
  { event: 'resolved', data: {} },
  { event: 'status_changed', data: { from: 'backlog', to: 'done' } },
  { event: 'created', data: {} },
]

describe('cairn done', () => {
  it('says it recorded fixed when --kind was omitted, and still sends fixed', async () => {
    const seen: Seen[] = []
    const base = await serve(closeServer([{ event: 'claimed', data: {} }]), seen)
    const { code, stderr } = await run(['done', 'ACME-7', '--resolution', 'shipped'], base, 'codex')
    expect(code).toBe(0)
    expect(seen.find((s) => s.method === 'PATCH')?.body?.resolutionKind).toBe('fixed')
    expect(stderr).toContain('recorded as fixed — use --kind verified|answered')
    expect(stderr).not.toContain('without ever being claimed')
  })

  it('says nothing about the kind when one was given', async () => {
    const seen: Seen[] = []
    const base = await serve(closeServer([{ event: 'claimed', data: {} }]), seen)
    const { stderr } = await run(['done', 'ACME-7', '--resolution', 'read it', '--kind', 'verified'], base, 'codex')
    expect(stderr).not.toContain('recorded as fixed')
  })

  it('warns, after closing, when nothing ever showed the work being done', async () => {
    const seen: Seen[] = []
    const base = await serve(closeServer(CLOSE_ONLY), seen)
    const { code, stderr } = await run(['done', 'ACME-7', '--resolution', 'shipped', '--kind', 'fixed'], base, 'claude-code')
    expect(code).toBe(0)
    expect(seen.some((s) => s.method === 'PATCH')).toBe(true)
    expect(stderr).toContain('ACME-7 was closed without ever being claimed')
  })

  it('does not warn when a commit or a move to in-review showed the work', async () => {
    for (const trace of [
      { event: 'git_commit', data: { sha: 'abc' } },
      { event: 'status_changed', data: { from: 'doing', to: 'in-review' } },
    ]) {
      const base = await serve(closeServer([...CLOSE_ONLY, trace]), [])
      const { stderr } = await run(['done', 'ACME-7', '--resolution', 'shipped', '--kind', 'fixed'], base, 'codex')
      expect(stderr).not.toContain('without ever being claimed')
    }
  })

  it('does not warn a person, who is documented as never claiming', async () => {
    const seen: Seen[] = []
    const base = await serve(closeServer(CLOSE_ONLY), seen)
    const { stderr } = await run(['done', 'ACME-7', '--resolution', 'shipped', '--kind', 'fixed'], base)
    expect(stderr).not.toContain('without ever being claimed')
    expect(seen.some((s) => s.path.includes('/activity'))).toBe(false)
  })
})

describe('cairn note', () => {
  const noteServer: Reply = () => ({ id: 'n', kind: 'note' })

  it('points a dead end at --kind attempt without changing what is stored', async () => {
    const seen: Seen[] = []
    const base = await serve(noteServer, seen)
    const { stderr } = await run(['note', 'ACME-7', 'bumped pool_size to 30, no change'], base, 'codex')
    expect(seen[0]?.body?.kind).toBe('note')
    expect(stderr).toContain('--kind attempt')
  })

  it.each(["tried the retry flag", "it didn't work", 'ruled out DNS', 'made no difference'])(
    'recognises "%s"',
    async (text) => {
      const base = await serve(noteServer, [])
      const { stderr } = await run(['note', 'ACME-7', text], base, 'codex')
      expect(stderr).toContain('--kind attempt')
    },
  )

  it('stays quiet for an ordinary note, or when a kind was given', async () => {
    for (const args of [
      ['note', 'ACME-7', 'the relay reads its config at boot'],
      ['note', 'ACME-7', 'tried X, no change', '--kind', 'finding'],
    ]) {
      const base = await serve(noteServer, [])
      const { stderr } = await run(args, base, 'codex')
      expect(stderr).not.toContain('--kind attempt')
    }
  })
})

describe('the briefing', () => {
  const briefing = {
    project: 'ACME',
    held: [{ ref: 'ACME-7', title: 'Wire the relay', status: 'doing', quiet: false }],
    inFlight: [], knowledge: [], staleClaims: [], lastSession: null,
  }

  it('carries the working rules in a few hundred bytes', async () => {
    const base = await serve(() => briefing, [])
    const { stdout } = await run(['context', '--project', 'ACME'], base)
    const start = stdout.indexOf('Start with: cairn check')
    expect(start).toBeGreaterThan(-1)
    const rules = stdout.slice(start).trim()
    expect(Buffer.byteLength(rules)).toBeLessThanOrEqual(300)
    for (const rule of ['Claim what you work', 'one task per sweep', '--kind attempt', 'checkpoint', 'in-review', 'done --kind fixed|verified|answered']) {
      expect(rules).toContain(rule)
    }
  })

  it('still says nothing when there is nothing to brief', async () => {
    const base = await serve(() => ({ ...briefing, project: null, held: [] }), [])
    const { stdout } = await run(['context'], base)
    expect(stdout).toBe('')
  })

  it('keeps the rules out of a single-file answer', async () => {
    const file = { path: 'src/a.ts', tasks: [{ ref: 'ACME-7', status: 'doing', title: 'x' }], knowledge: [], sessions: [] }
    const base = await serve(() => ({ ...briefing, file }), [])
    const { stdout } = await run(['context', '--file', 'src/a.ts'], base)
    expect(stdout).toContain('Cairn knows about src/a.ts')
    expect(stdout).not.toContain('Start with')
  })
})
