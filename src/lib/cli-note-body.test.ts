import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `cairn note <ref> --body -` (CAIRN-397). `--body` was ignored, so the note
 * died with a bare "a note body is required" and, unattended, was lost.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method?: string; path?: string; body?: Record<string, unknown> }

const serve = (seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method, path: req.url }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { ref: 'CAIRN-1', number: 1, id: 'x' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, stdin?: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-note-'))
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

const writes = (seen: Seen[]) => seen.filter((s) => s.method === 'POST')

const cases = [
  { name: 'cairn note', head: ['note', 'CAIRN-1'], path: '/api/v1/tasks/CAIRN-1/notes' },
  { name: 'cairn subject note', head: ['subject', 'note', 'LAB-1'], path: '/api/v1/subjects/LAB-1/notes' },
]

describe.each(cases)('$name --body', ({ head, path }) => {
  it('reads --body - from stdin and keeps the kind', async () => {
    const seen: Seen[] = []
    const { code } = await run([...head, '--body', '-', '--kind', 'finding'], await serve(seen), 'from stdin\n')
    expect(code).toBe(0)
    const [post] = writes(seen)
    expect(post?.path).toBe(path)
    expect(post?.body).toEqual({ note: 'from stdin', kind: 'finding' })
  })

  it('takes --body text', async () => {
    const seen: Seen[] = []
    const { code } = await run([...head, '--body', 'x'], await serve(seen))
    expect(code).toBe(0)
    expect(writes(seen)[0]?.body).toEqual({ note: 'x', kind: 'note' })
  })

  it('still takes the positional text', async () => {
    const seen: Seen[] = []
    const { code } = await run([...head, 'pos'], await serve(seen))
    expect(code).toBe(0)
    expect(writes(seen)[0]?.body).toEqual({ note: 'pos', kind: 'note' })
  })

  it('refuses a positional and --body together, sending nothing', async () => {
    const seen: Seen[] = []
    const { code, stderr } = await run([...head, 'x', '--body', 'y'], await serve(seen))
    expect(code).not.toBe(0)
    expect(stderr).toContain('pass the text or --body, not both')
    expect(writes(seen)).toEqual([])
  })

  it('refuses no text, naming the three forms, sending nothing', async () => {
    const seen: Seen[] = []
    const { code, stderr } = await run(head, await serve(seen))
    expect(code).not.toBe(0)
    expect(stderr).toContain('a note body is required ("<text>", --body <text>, or - for stdin)')
    expect(writes(seen)).toEqual([])
  })
})

describe('cairn checkpoint', () => {
  it('refuses --body without --summary, sending nothing', async () => {
    const seen: Seen[] = []
    const { code, stderr } = await run(['checkpoint', 'CAIRN-1', '--body', 'x'], await serve(seen))
    expect(code).not.toBe(0)
    expect(stderr).toContain('checkpoint takes --summary, not --body')
    expect(writes(seen)).toEqual([])
  })

  it('refuses --body alongside --summary, sending nothing', async () => {
    const seen: Seen[] = []
    const { code, stderr } = await run(['checkpoint', 'CAIRN-1', '--summary', 's', '--body', 'x'], await serve(seen))
    expect(code).not.toBe(0)
    expect(stderr).toContain('checkpoint takes --summary, not --body')
    expect(writes(seen)).toEqual([])
  })

  it('still takes --summary alone', async () => {
    const seen: Seen[] = []
    const { code } = await run(['checkpoint', 'CAIRN-1', '--summary', 'where things stand'], await serve(seen))
    expect(code).toBe(0)
    expect(writes(seen)[0]?.body).toEqual({ summary: 'where things stand' })
  })
})
