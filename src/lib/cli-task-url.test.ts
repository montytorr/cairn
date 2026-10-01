import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const serve = (data: (path: string) => unknown) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: data(req.url ?? '') }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-url-'))
  directories.push(home)
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: `${base}/`, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('error', reject)
    child.on('close', () => resolve({ stdout }))
  })
}

const task = { ref: 'ACME-42', number: 42, title: 'Wire the relay', status: 'todo', type: 'bug', priority: 'high' }

describe('task web url', () => {
  it('show carries it in TSV and JSON', async () => {
    const base = await serve(() => task)
    const url = `${base}/projects/ACME/tasks/42`
    expect((await run(['show', 'ACME-42'], base)).stdout).toContain(`url\t${url}`)
    expect(JSON.parse((await run(['show', 'ACME-42', '--json'], base)).stdout).url).toBe(url)
  })

  it('check adds it last, to task rows only', async () => {
    const base = await serve(() => ({
      results: [
        { ...task, kind: 'task', tokens: 10 },
        { kind: 'knowledge', ref: 'some-slug', title: 'A fact', tokens: 5 },
      ],
    }))
    const lines = (await run(['check', 'relay'], base)).stdout.replace(/\n$/, '').split('\n')
    expect(lines[1]!.split('\t').at(-1)).toBe('url')
    expect(lines[2]!.split('\t').at(-1)).toBe(`${base}/projects/ACME/tasks/42`)
    expect(lines[3]!.split('\t').at(-1)).toBe('')
  })

  it('list appends it as the last column', async () => {
    const base = await serve(() => ({ tasks: [{ ...task, ref: undefined, project: { key: 'ACME' } }] }))
    const lines = (await run(['list', '--project', 'ACME'], base)).stdout.trim().split('\n')
    expect(lines[1]!.split('\t').at(-1)).toBe('url')
    expect(lines[2]!.split('\t').at(-1)).toBe(`${base}/projects/ACME/tasks/42`)
  })

  it('next prints it beside the pick and in JSON', async () => {
    const base = await serve(() => ({ pick: { ...task, reason: 'top' }, then: [{ ...task, ref: 'ACME-43' }] }))
    const out = (await run(['next'], base)).stdout
    expect(out).toContain(`ACME-42  Wire the relay  ${base}/projects/ACME/tasks/42`)
    const json = JSON.parse((await run(['next', '--json'], base)).stdout)
    expect(json.then[0].url).toBe(`${base}/projects/ACME/tasks/43`)
  })
})
