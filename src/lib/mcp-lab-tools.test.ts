import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The MCP server holds no logic: each tool is an argv for the CLI. So the
 * test is a real protocol round trip against a `cairn` that only records what
 * it was run with, and asserts the argv each Lab tool builds — which is what
 * keeps the facade and the CLI's parser in step.
 *
 * Needs the SDK, which lives in mcp/node_modules (installed beside the
 * server, not at the root); without it there is nothing to run, and the suite
 * says so rather than failing a checkout that never installed it.
 */
const sdk = existsSync(join(process.cwd(), 'mcp/node_modules/@modelcontextprotocol/sdk'))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const session = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-mcp-'))
  directories.push(dir)
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'cairn')
  await writeFile(
    bin,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log('ok')
`,
  )
  await chmod(bin, 0o755)

  const child = spawn('node', ['mcp/server.mjs'], { env: { ...process.env, CAIRN_BIN: bin } })
  let buffer = ''
  const waiting = new Map<number, (message: Record<string, unknown>) => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number }
      if (message.id !== undefined) waiting.get(message.id)?.(message as Record<string, unknown>)
    }
  })
  let next = 1
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return {
    call,
    tool: async (name: string, args: Record<string, unknown>) => {
      await call('tools/call', { name, arguments: args })
      const lines = (await readFile(log, 'utf8')).trim().split('\n')
      return JSON.parse(lines.at(-1)!) as string[]
    },
    close: () => child.kill(),
  }
}

describe.skipIf(!sdk)('the Lab tools of the MCP server', () => {
  it('lists the seven Lab tools beside the existing ones', async () => {
    const s = await session()
    const listed = (await s.call('tools/list')) as { result: { tools: { name: string }[] } }
    const names = listed.result.tools.map((t) => t.name)
    for (const name of [
      'cairn_subject_list', 'cairn_subject_show', 'cairn_subject_add', 'cairn_subject_stage',
      'cairn_subject_note', 'cairn_subject_todo', 'cairn_handoff', 'cairn_check',
    ]) {
      expect(names).toContain(name)
    }
    s.close()
  })

  it('builds the argv the CLI parses', async () => {
    const s = await session()
    expect(
      await s.tool('cairn_subject_list', { query: 'pgvector', stage: 'exploring', category: 'planned', mine: true, limit: 5 }),
    ).toEqual(['subject', 'list', 'pgvector', '--stage', 'exploring', '--category', 'planned', '--mine', '--limit', '5'])
    expect(await s.tool('cairn_subject_show', { ref: 'LAB-12', full: true })).toEqual(['subject', 'show', 'LAB-12', '--full'])
    expect(
      await s.tool('cairn_subject_add', { title: 'Try X', body: '## Why', tags: ['search', 'infra'], owner: 'none' }),
    ).toEqual(['subject', 'add', 'Try X', '--body', '## Why', '--tag', 'search,infra', '--owner', 'none'])
    expect(await s.tool('cairn_subject_stage', { ref: 'LAB-12', stage: 'done', conclusion: 'Adopt it.' })).toEqual([
      'subject', 'stage', 'LAB-12', 'done', '--conclusion', 'Adopt it.',
    ])
    expect(await s.tool('cairn_subject_note', { ref: 'LAB-12', note: 'tried', kind: 'attempt' })).toEqual([
      'subject', 'note', 'LAB-12', 'tried', '--kind', 'attempt',
    ])
    expect(await s.tool('cairn_subject_todo', { ref: 'LAB-12', title: 'Benchmark', priority: 'high', noStart: true })).toEqual([
      'subject', 'todo', 'LAB-12', 'Benchmark', '--priority', 'high', '--no-start',
    ])
    expect(await s.tool('cairn_handoff', { ref: 'CAI-42', to: 'github:owner/repo' })).toEqual([
      'handoff', 'CAI-42', '--to', 'github:owner/repo',
    ])
    expect(await s.tool('cairn_handoff', { ref: 'CAI-42', undo: true })).toEqual(['handoff', 'CAI-42', '--undo'])
    s.close()
  })
})
