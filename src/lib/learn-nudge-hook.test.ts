import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * CAIRN-323: on Stop, ask the agent once per session to `cairn learn`, and
 * only after a turn that did work. A block keeps the agent going for one more
 * reply the person waits for, so every "never" below is a reply saved.
 */
const HOOK = join(process.cwd(), 'hooks', 'cairn-learn-nudge.mjs')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-nudge-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const transcript = (rows: unknown[]) => {
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

const run = (payload: unknown, env: Record<string, string> = {}) =>
  new Promise<string>((done) => {
    const child = spawn('node', [HOOK], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => done(out))
    child.stdin.end(JSON.stringify(payload))
  })

const blocked = (out: string) => (out ? JSON.parse(out).decision === 'block' : false)

const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const tool = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
})
const said = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

const codexPrompt = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
})
const codexShell = (script: string) => ({
  type: 'response_item',
  payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', script] }) },
})

describe('the learn nudge', () => {
  it('asks after a turn that edited a file, and only once per session', async () => {
    const path = transcript([prompt('Fix the login redirect'), tool('Edit', { file_path: '/a.ts' }), said('Done.')])
    const first = await run({ session_id: 's1', transcript_path: path })
    expect(blocked(first)).toBe(true)
    expect(JSON.parse(first).reason).toMatch(/cairn learn/)
    expect(await run({ session_id: 's1', transcript_path: path })).toBe('')
    expect(Object.keys(JSON.parse(readFileSync(join(dir, '.cairn', 'nudged.json'), 'utf8')))).toEqual(['s1'])
  })

  it('asks after a commit, in a Codex rollout too', async () => {
    const path = transcript([codexPrompt('Ship it'), codexShell('git add -A && git commit -m "fix: x"')])
    expect(blocked(await run({ session_id: 'c1', transcript_path: path }))).toBe(true)
  })

  it('stays quiet after a turn that only read and talked', async () => {
    const path = transcript([
      prompt('Fix the login redirect'),
      tool('Edit', { file_path: '/a.ts' }),
      prompt('What does the auth module do?'),
      tool('Read', { file_path: '/auth.ts' }),
      tool('Bash', { command: 'git log --oneline -5' }),
      said('It checks the cookie.'),
    ])
    expect(await run({ session_id: 's2', transcript_path: path })).toBe('')
  })

  it('never asks on the continuation its own block caused', async () => {
    const path = transcript([prompt('Fix it'), tool('Write', { file_path: '/a.ts' })])
    expect(await run({ session_id: 's3', transcript_path: path, stop_hook_active: true })).toBe('')
  })

  it('never asks a session that already ran cairn learn, however the words appear elsewhere', async () => {
    const briefing = { type: 'user', isMeta: true, message: { role: 'user', content: "Facts still true next month: 'cairn learn' with a scope." } }
    const lookedAtHelp = transcript([briefing, prompt('Fix it'), tool('Bash', { command: 'cairn learn --help' }), tool('Edit', { file_path: '/a.ts' })])
    expect(blocked(await run({ session_id: 's4', transcript_path: lookedAtHelp }))).toBe(true)

    const learned = transcript([
      prompt('Fix it'),
      tool('Bash', { command: 'cd /repo && cairn learn "Deferred FKs go after the backfill" --project CAIRN --body -' }),
      prompt('Now the other one'),
      tool('Edit', { file_path: '/b.ts' }),
    ])
    expect(await run({ session_id: 's5', transcript_path: learned })).toBe('')
  })

  it('stays out of summariser runs, and off when switched off', async () => {
    const path = transcript([prompt('Fix it'), tool('Edit', { file_path: '/a.ts' })])
    expect(await run({ session_id: 's6', transcript_path: path }, { CAIRN_SUMMARISER: '1' })).toBe('')
    expect(await run({ session_id: 's6', transcript_path: path }, { AGENT_MEMORY_SUMMARISER: '1' })).toBe('')
    expect(await run({ session_id: 's6', transcript_path: path }, { CAIRN_LEARN_NUDGE: '0' })).toBe('')
  })

  it('says nothing when the payload names no transcript', async () => {
    expect(await run({ session_id: 's7' })).toBe('')
    expect(await run({ session_id: 's7', transcript_path: join(dir, 'missing.jsonl') })).toBe('')
  })
})
