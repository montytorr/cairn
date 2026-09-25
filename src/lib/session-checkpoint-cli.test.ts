import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

describe('cairn session checkpoint CLI', () => {
  it('sends an ongoing session with all requested fields, without closing or checkpointing held tasks', async () => {
    const received: unknown[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { id: 'one', endedAt: null, checkpointed: [] } }))
    })
    const home = mkdtempSync(join(tmpdir(), 'cairn-session-cli-'))
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await exec('node', ['cli/cairn.mjs', 'session', 'checkpoint', '--id', 'agent:example',
        '--platform', 'other', '--agent', 'example-agent', '--project', 'DEMO',
        '--cwd', '/work/demo', '--request', 'Feature work',
        '--completed', 'In progress', '--json'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CAIRN_API_KEY: 'test-key',
          CAIRN_BASE_URL: `http://127.0.0.1:${address.port}` },
      })
      expect(received).toEqual([{ method: 'POST', path: '/api/v1/sessions', body: {
        externalId: 'agent:example', platformSource: 'other', agentId: 'example-agent',
        project: 'DEMO', cwd: '/work/demo', request: 'Feature work',
        completed: 'In progress', files: [], taskRefs: [], ongoing: true, checkpointHeld: false,
      } }])
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * CAIRN-286: `session end` never resolved a project, and nothing else sent
 * one, so every live session landed unattributed. It now resolves the way
 * `cairn context` does — the local map — and sends the checkout's remote so
 * the server can match it when the map has no entry.
 */
describe('cairn session end project attribution', () => {
  const capture = async (setup: (home: string, repo: string) => string[]) => {
    const received: { body: Record<string, unknown> }[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { id: 'one', checkpointed: [] } }))
    })
    const home = mkdtempSync(join(tmpdir(), 'cairn-session-project-'))
    const repo = join(home, 'work', 'demo')
    try {
      mkdirSync(join(repo, 'src'), { recursive: true })
      await exec('git', ['init', '-q', repo])
      await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/demo.git'])
      const args = setup(home, repo)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await exec('node', ['cli/cairn.mjs', 'session', 'end', '--id', 's1', '--json', ...args], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CAIRN_API_KEY: 'test-key',
          CAIRN_BASE_URL: `http://127.0.0.1:${address.port}` },
      })
      return received[0]?.body ?? {}
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }

  const map = (home: string, entries: Record<string, string>) => {
    mkdirSync(join(home, '.cairn'), { recursive: true })
    writeFileSync(join(home, '.cairn', 'projects.json'), JSON.stringify(entries))
  }

  it('takes the project from the map, longest prefix, and sends the remote', async () => {
    const body = await capture((home, repo) => {
      map(home, { [join(home, 'work')]: 'WORK', [repo]: 'DEMO' })
      return ['--cwd', join(repo, 'src')]
    })
    expect(body.project).toBe('DEMO')
    expect(body.repo).toBe('git@github.com:example/demo.git')
  })

  it('sends the remote alone when the map has no entry, for the server to match', async () => {
    const body = await capture((_home, repo) => ['--cwd', repo])
    expect(body.project).toBeUndefined()
    expect(body.repo).toBe('git@github.com:example/demo.git')
  })

  it('keeps an explicit --project over the map', async () => {
    const body = await capture((home, repo) => {
      map(home, { [repo]: 'DEMO' })
      return ['--cwd', repo, '--project', 'OTHER']
    })
    expect(body.project).toBe('OTHER')
  })
})
