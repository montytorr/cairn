import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Knowledge history from the terminal (CAIRN-266): `--reason` reaches the
 * PATCH on both verbs that produce a revision, and `know --history` credits
 * each version to the edit that produced it rather than the one that ended it.
 * That second point is an off-by-one waiting to happen, because a revision row
 * names who REPLACED the version it holds.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { path?: string; body?: Record<string, unknown> }

const serve = (seen: Seen, data: unknown) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.path = req.url
        if (raw) try { seen.body = JSON.parse(raw) } catch { /* not json */ }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-history-'))
  directories.push(home)
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    let stdout = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

describe('--reason reaches the wire', () => {
  it('on relearn', async () => {
    const seen: Seen = {}
    const base = await serve(seen, { slug: 'a-fact' })
    await run(['relearn', 'a-fact', '--body', 'new', '--reason', 'it changed'], base)
    expect(seen.body).toMatchObject({ body: 'new', reason: 'it changed' })
  })

  it('on unlearn --superseded-by', async () => {
    const seen: Seen = {}
    const base = await serve(seen, { slug: 'a-fact' })
    await run(['unlearn', 'a-fact', '--superseded-by', 'b-fact', '--reason', 'wrong'], base)
    expect(seen.body).toEqual({ supersededBy: 'b-fact', reason: 'wrong' })
  })
})

describe('know --history', () => {
  const history = {
    slug: 'a-fact',
    title: 'Third title',
    version: 3,
    createdAt: '2026-09-01T10:00:00.000Z',
    author: 'codex · first',
    revisions: [
      { revision: 2, title: 'Second title', body: 'two', change: 'rescoped',
        edited_by: 'claude · third', edited_at: '2026-09-03T10:00:00.000Z', reason: null },
      { revision: 1, title: 'First title', body: 'one', change: 'relearned',
        edited_by: 'claude · second', edited_at: '2026-09-02T10:00:00.000Z', reason: 'was wrong' },
    ],
  }

  it('credits each version to the edit that produced it', async () => {
    const seen: Seen = {}
    const base = await serve(seen, history)
    const { code, stdout } = await run(['know', 'a-fact', '--history'], base)

    expect(code).toBe(0)
    expect(seen.path).toBe('/api/v1/knowledge/a-fact/history')
    const rows = stdout.trim().split('\n').slice(2).map((line) => line.split('\t'))
    expect(rows).toEqual([
      ['3 (live)', 'rescoped', 'claude · third', '2026-09-03 12:00', '', 'Third title'],
      ['2', 'relearned', 'claude · second', '2026-09-02 12:00', 'was wrong', 'Second title'],
      ['1', 'learned', 'codex · first', '2026-09-01 12:00', '', 'First title'],
    ])
  })
})

describe('know --unused (CAIRN-270)', () => {
  it('asks for the window, prints never for an entry with no record, and says what is not counted', async () => {
    const seen: Seen = {}
    const base = await serve(seen, {
      count: 1,
      days: 45,
      counted: 'the session briefing is not recorded',
      results: [{ slug: 'old-fact', title: 'Old fact', createdAt: '2026-06-01T00:00:00.000Z', lastRecalled: null }],
    })
    const home = await mkdtemp(join(tmpdir(), 'cairn-unused-'))
    directories.push(home)
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('node', ['cli/cairn.mjs', 'know', '--unused', '--days', '45'], {
        env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', reject)
      child.on('close', () => resolve({ stdout: out, stderr: err }))
    })

    expect(seen.path).toBe('/api/v1/knowledge?unused=45&limit=50')
    expect(stdout).toContain('old-fact\tnever\t2026-06-01\tOld fact')
    expect(stderr).toContain('not recalled in 45 days — the session briefing is not recorded')
  })
})
