import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `--allow-dangling` lives in the global KNOWN_FLAGS set, so every verb parses
 * it whether or not it sends it. `relearn` parsed it and dropped it, and since
 * PATCH runs the same reference check as POST, the correction was refused with
 * the documented way past it silently discarded.
 *
 * That is the failure the flag guard exists to prevent — an argument that looks
 * accepted and is not — reintroduced by the flag that was added to satisfy it.
 * So this asserts what reaches the wire, per verb.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Captures the last request body the CLI sent. */
const serve = (seen: { body?: Record<string, unknown>; method?: string; url?: string }) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.method = req.method
        seen.url = req.url
        if (raw) try { seen.body = JSON.parse(raw) } catch { /* not json */ }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { slug: 'a-fact' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-flag-'))
  directories.push(home)
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
}

describe('--allow-dangling reaches the wire', () => {
  it('on relearn, which runs the same reference check as a write', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    await run(['relearn', 'a-fact', '--body', 'see [[something]]', '--allow-dangling'], base)
    expect(seen.body?.allowUnresolvedRefs).toBe(true)
  })

  it('on learn', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    await run(['learn', 'A fact', '--body', 'see [[something]]', '--global', '--allow-dangling'], base)
    expect(seen.body?.allowUnresolvedRefs).toBe(true)
  })

  it('and is absent when not asked for, so the check stays on by default', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    await run(['relearn', 'a-fact', '--body', 'see [[something]]'], base)
    expect(seen.body?.allowUnresolvedRefs).toBeUndefined()
  })

  /**
   * A hard delete is refused while live entries reference the entry
   * (CAIRN-347), and the refusal names this flag as the way past — so it has
   * to arrive. On the query string, because a DELETE body is not reliable.
   */
  it('on unlearn, as a query parameter on the delete', async () => {
    const seen: { method?: string; url?: string } = {}
    const base = await serve(seen)
    await run(['unlearn', 'a-fact', '--allow-dangling'], base)
    expect(seen.method).toBe('DELETE')
    expect(seen.url).toBe('/api/v1/knowledge/a-fact?allowUnresolvedRefs=true')
  })

  it('and a plain unlearn asks for the check', async () => {
    const seen: { method?: string; url?: string } = {}
    const base = await serve(seen)
    await run(['unlearn', 'a-fact'], base)
    expect(seen.method).toBe('DELETE')
    expect(seen.url).toBe('/api/v1/knowledge/a-fact')
  })
})
