import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `cairn project describe` as an agent meets it (CAIRN-374): spawned against a
 * fake server, so what is asserted is what reaches the wire and what is
 * printed.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method?: string; path?: string; body?: Record<string, unknown> }

const serve = (reply: { status?: number; body: unknown }, seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method, path: req.url }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, stdin?: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-describe-'))
  directories.push(home)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

const project = { id: 'p1', key: 'CIVIC', title: 'Civic', description: 'x', status: 'active' }
const ok = { body: { success: true, data: project } }

describe('cairn project describe', () => {
  it('sends the body read from stdin, trimmed, as the description', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code } = await run(['project', 'describe', 'CIVIC', '--body', '-'], base, '\n## Status\n\nRetired.\n\n')

    expect(code).toBe(0)
    expect(seen).toEqual([
      { method: 'PATCH', path: '/api/v1/projects/CIVIC', body: { description: '## Status\n\nRetired.' } },
    ])
  })

  it('takes a one-line body inline', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    await run(['project', 'describe', 'CIVIC', '--body', 'Retired.'], base)
    expect(seen[0]?.body).toEqual({ description: 'Retired.' })
  })

  it('refuses an empty body without calling the server', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code, stderr } = await run(['project', 'describe', 'CIVIC', '--body', '-'], base, '  \n')

    expect(code).not.toBe(0)
    expect(stderr).toContain('empty')
    expect(stderr).toContain('--clear')
    expect(seen).toEqual([])
  })

  it('sets null with --clear', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code } = await run(['project', 'describe', 'CIVIC', '--clear'], base)

    expect(code).toBe(0)
    expect(seen).toEqual([{ method: 'PATCH', path: '/api/v1/projects/CIVIC', body: { description: null } }])
  })

  it('refuses --clear together with --body', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code, stderr } = await run(['project', 'describe', 'CIVIC', '--clear', '--body', 'x'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('not both')
    expect(seen).toEqual([])
  })

  it('lists describe among the subcommands when one is unknown', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code, stderr } = await run(['project', 'nope', 'CIVIC'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('unknown subcommand "nope"')
    expect(stderr).toContain('describe')
    expect(seen).toEqual([])
  })

  it('shows usage when no body is given', async () => {
    const seen: Seen[] = []
    const base = await serve(ok, seen)
    const { code, stderr } = await run(['project', 'describe', 'CIVIC'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('usage: cairn project describe <KEY> --body -')
    expect(seen).toEqual([])
  })

  it("prints the server's list of what to fix when the body is refused", async () => {
    const seen: Seen[] = []
    const base = await serve(
      {
        status: 400,
        body: {
          success: false,
          code: 'validation_failed',
          error: 'This description is hard to read as written, so it was not saved.',
          problems: ['Wrap `a.b.c` in backticks — it is code.'],
        },
      },
      seen,
    )
    const { code, stderr } = await run(['project', 'describe', 'CIVIC', '--body', 'a.b.c is broken'], base)

    expect(code).not.toBe(0)
    expect(stderr).toContain('hard to read')
    expect(stderr).toContain('Wrap `a.b.c` in backticks')
  })
})
