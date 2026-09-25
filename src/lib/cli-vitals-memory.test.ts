import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `cairn vitals` is how an agent asks whether the memory is being used. The
 * numbers existed and were rendered only on a web page — the one place the
 * population they measure cannot look. So this asserts what lands in a
 * terminal, and that a missing block does not take the monitor down with it.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const report = (memory: unknown) => ({
  windowHours: 24,
  sessions: { recent: 3, recentWithFiles: 2, baseline: 1, baselineWithFiles: 1 },
  tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedWithoutTrace: 0 },
  agents: [],
  findings: [],
  autoReleased: 0,
  knowledgeWritten: 2,
  memory,
})

/**
 * Every request the CLI made, so `--notify` can be asserted on what it posted
 * rather than on what it printed. The note is the half an agent actually
 * reads: it is what lands on the task.
 */
type Posted = { path: string; body: Record<string, unknown> }

const serve = (body: unknown, posted: Posted[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        if (req.method === 'POST') {
          posted.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} })
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: body }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (body: unknown, args: string[]) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-vitals-'))
  directories.push(home)
  const posted: Posted[] = []
  const base = await serve(body, posted)
  return new Promise<{ stdout: string; code: number | null; posted: Posted[] }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, code, posted }))
  })
}

const vitals = (body: unknown) => run(body, ['vitals', '--all'])

const memory = (extra: Record<string, unknown> = {}) => ({
  windowHours: 24,
  searches: 12,
  widened: 3,
  zeroResults: 2,
  byAgent: [],
  tasksFiled: 5,
  tasksFiledWithoutChecking: 4,
  recentMisses: ['postgres generated columns'],
  ...extra,
})

describe('cairn vitals', () => {
  it('reports whether the memory was consulted, where an agent can read it', async () => {
    const { stdout } = await vitals(report(memory()))
    expect(stdout).toContain('memory 12 searches (3 widened, 2 empty)')
    expect(stdout).toContain('4 of 5 tasks filed without checking first')
    expect(stdout).toContain('asked for, not held: postgres generated columns')
  })

  it('still answers when the memory aggregate is unreadable', async () => {
    const { stdout, code } = await vitals(report(null))
    expect(code).toBe(0)
    expect(stdout).toContain('knowledge written 2')
    expect(stdout).not.toContain('memory ')
  })
})

/**
 * Looking a fact up by name is the half of "do we recall what we know" that
 * nothing recorded before migration 053 and nothing displayed after it — the
 * numbers were being collected into a drawer. A miss is the interesting one:
 * it is a dangling knowledge reference caught in the act of being followed.
 */
describe('cairn vitals reports facts looked up by name', () => {
  it('counts the direct reads and the ones that named nothing we hold', async () => {
    const { stdout } = await vitals(
      report(memory({ directReads: 9, directReadMisses: 2, recentSlugMisses: [] })),
    )
    expect(stdout).toContain('direct reads 9 by name (2 for a slug we do not hold)')
  })

  it('names each slug that was asked for and does not exist', async () => {
    const { stdout } = await vitals(
      report(
        memory({
          directReads: 4,
          directReadMisses: 2,
          recentSlugMisses: ['zzz-this-slug-does-not-exist', 'clawdius-sever'],
        }),
      ),
    )
    expect(stdout).toContain('looked up by name, no such entry: zzz-this-slug-does-not-exist')
    expect(stdout).toContain('looked up by name, no such entry: clawdius-sever')
    // Said differently from a search that found nothing, because it means
    // something different: a name someone believed in, not a phrasing the
    // index missed. Both are in this output at once.
    expect(stdout).toContain('asked for, not held: postgres generated columns')
  })

  it('says nothing extra when nobody looked anything up', async () => {
    // The common case. The memory block is already long enough to be skimmed,
    // and a row of zeroes is what teaches the eye to skim it.
    const { stdout } = await vitals(
      report(memory({ directReads: 0, directReadMisses: 0, recentSlugMisses: [] })),
    )
    expect(stdout).toContain('memory 12 searches')
    expect(stdout).not.toContain('direct reads')
    expect(stdout).not.toContain('looked up by name')
  })

  it('prints no zero for a server too old to have counted', async () => {
    // Migration 052 sends none of the three keys. `0 direct reads` there is a
    // confident wrong answer to a question the server cannot answer, which is
    // exactly why tasks.closedWithoutTrace is optional too.
    const { stdout } = await vitals(report(memory()))
    expect(stdout).toContain('memory 12 searches')
    expect(stdout).not.toContain('direct reads')
    expect(stdout).not.toContain('NaN')
    expect(stdout).not.toContain('undefined')
  })

  it('carries them into the --notify note, which is the copy an agent reads', async () => {
    const body = report(
      memory({ directReads: 4, directReadMisses: 1, recentSlugMisses: ['clawdius-sever'] }),
    )
    ;(body as { findings: unknown[] }).findings = [
      { code: 'nothing-closed', severity: 'warning', message: 'something is off' },
    ]
    const { posted } = await run(body, ['vitals', '--notify', 'CAIRN-254'])
    const note = posted.find((p) => p.path.includes('/notes'))
    expect(note).toBeDefined()
    expect(String(note?.body.note)).toContain('direct reads 4 by name (1 for a slug we do not hold)')
    expect(String(note?.body.note)).toContain('looked up by name, no such entry: clawdius-sever')
  })
})

/**
 * Migration 065's signals, in the terminal. The claims nobody is on and the
 * per-runtime split are the numbers CAIRN-282 found invisible everywhere, and
 * `cairn vitals` is where the agents that hold those claims look.
 */
describe('cairn vitals shows the signals cairn_vitals cannot see', () => {
  const signals = {
    windowHours: 24,
    sessions: { recent: 3, recentSummarised: 1, baseline: 1, baselineSummarised: 1, summariserRecent: 2, summariserBaseline: 0 },
    runtimes: [
      { runtime: 'openclaw', host: 'linux', recent: 2, recentSummarised: 0, baseline: 9, baselineSummarised: 7, lastSeenAt: '2026-09-25T09:00:00Z' },
    ],
    claims: {
      held: 22,
      quiet2h: 17,
      quiet24h: 10,
      quietest: [
        { ref: 'BB-385', title: 'Fleet-global MEV auth cooldown', claimedBy: 'openclaw · Dev', lastActivityAt: null, quietMinutes: 10080 },
      ],
    },
    reaper: { releasedInWindow: 0, released7d: 0, lastReleaseAt: null, maintenanceLastWriteAt: null },
    absentAgents: [],
    knowledge: { current: 424, neverVerified: 421, unverified30d: 422, verifiedInWindow: 0, lastVerifiedAt: null },
  }

  it('lists quiet claims, runtimes and verification', async () => {
    const { stdout } = await vitals({ ...report(memory()), signals })
    expect(stdout).toContain('claims 17 of 22 quiet >2h, 10 >24h; auto-released 0 in 7d (last never)')
    expect(stdout).toContain('quiet 168h: BB-385')
    expect(stdout).toContain('openclaw@linux: 2 sessions, 0 summarised (week before 9, 7)')
    expect(stdout).toContain('summariser runs not counted as sessions: 2')
    expect(stdout).toContain('knowledge 421 of 424 never verified')
  })

  it('prints none of it for a server that cannot send it', async () => {
    const { stdout, code } = await vitals(report(memory()))
    expect(code).toBe(0)
    expect(stdout).not.toContain('quiet >2h')
  })
})
