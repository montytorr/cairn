import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The session-end hook, end to end, against a fake `cairn` and a fake
 * `claude -p`. CAIRN-287: summariser runs were being recorded as sessions
 * (46% of Mac rows), summariser failures vanished without a trace, and a
 * failed summary left "hello" or a whole skill expansion as the request.
 */
const HOOK = resolve('hooks/cairn-session-end.mjs')
const SUMMARISER_PROMPT = 'You are writing one entry in an engineering memory that other agents read months later.'

let dir: string

const fake = (name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const lines = (name: string) => {
  const path = join(dir, name)
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', timestamp: '2026-09-25T09:00:00.000Z', cwd: '/work/demo',
  message: { role: 'user', content: text }, ...extra,
})
const assistant = (content: unknown[]) => ({
  type: 'assistant', timestamp: '2026-09-25T09:05:00.000Z', message: { role: 'assistant', content },
})
const edit = (path: string) => assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: path } }])

const transcript = (name: string, rows: unknown[]) => {
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

const run = (payload: unknown, env: Record<string, string> = {}) =>
  new Promise<number | null>((done) => {
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '', HOME: dir, OUT: dir,
      CAIRN_CLI: join(dir, 'cairn'), CAIRN_SUMMARY_CLI: join(dir, 'claude'),
      CAIRN_SUMMARY_MIN_INTERVAL_MS: '0', ...env,
    } as unknown as NodeJS.ProcessEnv
    const child = spawn('node', [HOOK], { env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('close', done)
    child.stdin.end(JSON.stringify(payload))
  })

const argValue = (args: string[], flag: string) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

const FAKE_CLAUDE = `
const fs = require('fs')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.OUT + '/summariser.jsonl', JSON.stringify({
    args, cwd: process.cwd(),
    flags: [process.env.CAIRN_SUMMARISER, process.env.QUARRY_SUMMARISER, process.env.AGENT_MEMORY_SUMMARISER],
  }) + '\\n')
  const mode = process.env.FAKE_MODE ?? 'ok'
  if (mode === 'fail') { process.stderr.write('Not logged in · Please run /login'); process.exit(1) }
  if (mode === 'old' && args.includes('--no-session-persistence')) {
    process.stderr.write("error: unknown option '--no-session-persistence'"); process.exit(1)
  }
  process.stdout.write(JSON.stringify({
    request: 'Fix the login redirect', learned: 'The cookie was lax', completed: 'Patched auth.ts', next_steps: '',
  }))
})`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-hook-'))
  fake('cairn', `require('fs').appendFileSync(process.env.OUT + '/cli.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')`)
  fake('claude', FAKE_CLAUDE)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the session-end hook', () => {
  it('never records a summariser run', async () => {
    const path = transcript('child', [
      user(`${SUMMARISER_PROMPT}\n\nReturn ONLY a JSON object…\n\n---\n\n# What was asked\nwork on CAIRN-12`),
      assistant([{ type: 'text', text: '{"request":"x"}' }]),
    ])
    await run({ transcript_path: path, session_id: 'child', cwd: '/work/demo' })
    expect(lines('cli.jsonl')).toEqual([])
    expect(lines('summariser.jsonl')).toEqual([])
  })

  it('never records a summariser run even with files in it, however it was launched', async () => {
    const path = transcript('quarry-child', [
      user('<system-reminder>SessionStart context</system-reminder>'),
      user('You are writing one entry in a sales memory that other agents read.\n\n---\nedited src/a.ts'),
      edit('/work/demo/src/a.ts'),
    ])
    await run({ transcript_path: path, session_id: 'quarry-child' })
    expect(lines('cli.jsonl')).toEqual([])
  })

  it('keeps a person who resumed a summariser run, without its prompt', async () => {
    const path = transcript('resumed', [
      user(`${SUMMARISER_PROMPT}\n\n---\n\n# What was asked\nsomething else`),
      user('Please fix the login redirect in auth.ts'),
      edit('/work/demo/auth.ts'),
    ])
    await run({ transcript_path: path, session_id: 'resumed', cwd: '/work/demo' }, { FAKE_MODE: 'fail' })
    const [args] = lines('cli.jsonl')
    expect(argValue(args, '--request')).toBe('Please fix the login redirect in auth.ts')
  })

  it("exits at once inside Quarry's summariser, not only its own", async () => {
    const path = transcript('quarry', [user('Please fix the login redirect'), edit('/work/demo/a.ts')])
    await run({ transcript_path: path, session_id: 'quarry' }, { QUARRY_SUMMARISER: '1' })
    expect(lines('cli.jsonl')).toEqual([])
  })

  it('asks the summariser without persistence, from a scratch directory, with every guard set', async () => {
    const path = transcript('ok', [user('Please fix the login redirect'), edit('/work/demo/a.ts')])
    await run({ transcript_path: path, session_id: 'ok', cwd: '/work/demo' })
    const [call] = lines('summariser.jsonl')
    expect(call.args).toContain('--no-session-persistence')
    expect(call.cwd).not.toBe('/work/demo')
    expect(call.flags).toEqual(['1', '1', '1'])
    const [args] = lines('cli.jsonl')
    expect(argValue(args, '--learned')).toBe('The cookie was lax')
  })

  it('asks again without the flag when the installed claude predates it', async () => {
    const path = transcript('old', [user('Please fix the login redirect'), edit('/work/demo/a.ts')])
    await run({ transcript_path: path, session_id: 'old' }, { FAKE_MODE: 'old' })
    expect(lines('summariser.jsonl').map((c) => c.args.includes('--no-session-persistence'))).toEqual([true, false])
    expect(argValue(lines('cli.jsonl')[0], '--completed')).toBe('Patched auth.ts')
  })

  it('logs a failed summary, records the first real request, and re-summarises it later', async () => {
    const path = transcript('failed', [
      user('<local-command-caveat>Caveat: …</local-command-caveat>', { isMeta: true }),
      user('hello'),
      user('Base directory for this skill: /skills/cairn\n\n# Cairn\n…', { isMeta: true }),
      user('  Audit   the vitals\nendpoint for stale rows  '),
      edit('/work/demo/vitals.ts'),
    ])
    await run({ transcript_path: path, session_id: 'failed', cwd: '/work/demo' }, { FAKE_MODE: 'fail' })

    const [first] = lines('cli.jsonl')
    expect(argValue(first, '--request')).toBe('Audit the vitals endpoint for stale rows')
    expect(first).not.toContain('--learned')
    expect(readFileSync(join(dir, '.cairn', 'summariser.log'), 'utf8')).toMatch(/claude failed: exit 1: Not logged in/)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, '.cairn', 'unsummarised.json'), 'utf8')))).toEqual(['failed'])

    // The next session to end with a working summariser picks it up.
    const next = transcript('next', [user('Tidy the README'), edit('/work/demo/README.md')])
    await run({ transcript_path: next, session_id: 'next', cwd: '/work/demo' }, { CAIRN_SUMMARY_RETRY_SPACING_MS: '0' })

    const calls = lines('cli.jsonl')
    expect(calls.map((a) => argValue(a, '--id'))).toEqual(['failed', 'next', 'failed'])
    const retry = calls[2]
    expect(retry).toContain('--no-checkpoint')
    expect(argValue(retry, '--learned')).toBe('The cookie was lax')
    expect(JSON.parse(readFileSync(join(dir, '.cairn', 'unsummarised.json'), 'utf8'))).toEqual({})
  })

  it('does not retry while the summariser is still failing', async () => {
    const a = transcript('a', [user('Please fix the login redirect'), edit('/work/demo/a.ts')])
    const b = transcript('b', [user('Please fix the logout redirect'), edit('/work/demo/b.ts')])
    await run({ transcript_path: a, session_id: 'a' }, { FAKE_MODE: 'fail' })
    await run({ transcript_path: b, session_id: 'b' }, { FAKE_MODE: 'fail', CAIRN_SUMMARY_RETRY_SPACING_MS: '0' })
    expect(lines('summariser.jsonl')).toHaveLength(2)
    expect(lines('cli.jsonl').map((args) => argValue(args, '--id'))).toEqual(['a', 'b'])
  })

  it("strips OpenClaw's conversation wrapper and keeps what the person wrote", async () => {
    const path = transcript('openclaw', [
      user('[OpenClaw conversation info: sender={"id":"42","name":"Cal"}]\nDeploy the hermes fix to staging'),
      user('[OpenClaw conversation info: sender={"id":"42"}]'),
      edit('/work/demo/deploy.sh'),
    ])
    await run({ transcript_path: path, session_id: 'openclaw' }, { FAKE_MODE: 'fail' })
    expect(argValue(lines('cli.jsonl')[0], '--request')).toBe('Deploy the hermes fix to staging')
  })

  it('reads the same wrapper out of a Codex rollout, which is what OpenClaw writes', async () => {
    const codex = (type: string, payload: unknown) => ({ type, timestamp: '2026-09-25T09:00:00.000Z', payload })
    const say = (role: string, text: string) =>
      codex('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] })
    const path = transcript('rollout-2026-09-25T09-00-00-11111111-2222-3333-4444-555555555555', [
      codex('session_meta', { id: '11111111-2222-3333-4444-555555555555' }),
      codex('turn_context', { cwd: '/srv/openclaw/workspace' }),
      say('user', '[OpenClaw conversation info: sender={"id":"42"}]\nRotate the staging certificate'),
      codex('response_item', { type: 'function_call', arguments: '{"cmd":"edit deploy/certs.sh"}' }),
    ])
    await run({ transcript_path: path }, { FAKE_MODE: 'fail', CAIRN_PLATFORM: 'openclaw' })
    const [args] = lines('cli.jsonl')
    expect(argValue(args, '--request')).toBe('Rotate the staging certificate')
    expect(argValue(args, '--platform')).toBe('openclaw')
  })

  it('never records a summariser run from a Codex rollout either', async () => {
    const path = transcript('rollout-2026-09-25T09-00-00-66666666-2222-3333-4444-555555555555', [
      { type: 'session_meta', payload: { id: 'x' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARISER_PROMPT}\n---\nedited src/a.ts` }] } },
    ])
    await run({ transcript_path: path })
    expect(lines('cli.jsonl')).toEqual([])
  })

  it('takes what was typed after a slash command as the request', async () => {
    const path = transcript('slash', [
      user('<command-name>/fix</command-name>\n<command-message>fix</command-message>\n<command-args>the login redirect loops</command-args>'),
      user('We have a debug to perform…', { isMeta: true }),
      edit('/work/demo/a.ts'),
    ])
    await run({ transcript_path: path, session_id: 'slash' }, { FAKE_MODE: 'fail' })
    expect(argValue(lines('cli.jsonl')[0], '--request')).toBe('the login redirect loops')
  })
})
