import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

const run = (command: string, args: string[], environment: NodeJS.ProcessEnv, input = '') => new Promise<{
  code: number | null
  stdout: string
  stderr: string
}>((resolve, reject) => {
  const child = spawn(command, args, { env: environment })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stdout, stderr }))
  child.stdin.end(input)
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Hermes Agent by Nous Research hooks', () => {
  it('installs one pre-LLM briefing hook without replacing existing Hermes hooks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cairn-hermes-hook-test-'))
    temporaryDirectories.push(directory)
    const bin = join(directory, 'bin')
    const hooks = join(directory, 'hooks.json')
    const commandLog = join(directory, 'hermes.log')
    const fakeHermes = join(bin, 'hermes')
    await mkdir(bin)
    await writeFile(hooks, JSON.stringify({ pre_tool_call: [{ command: '/existing/hook', timeout: 5 }] }))
    await writeFile(fakeHermes, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const [group, action] = args
const hooks = process.env.FAKE_HOOKS
if (group === 'config' && action === 'get' && args[2] === 'hooks') {
  if (process.env.FAKE_HERMES_GET_FAILURE) {
    process.stderr.write('unsupported config command\\n')
    process.exit(64)
  }
  process.stdout.write(fs.readFileSync(hooks, 'utf8'))
  process.exit(0)
}
if (group === 'config' && action === 'set' && args[2] === '--force' && args[3] === 'hooks') {
  if (!process.env.FAKE_HERMES_SET_DISCARDS) fs.writeFileSync(hooks, args[4])
  fs.appendFileSync(process.env.FAKE_HERMES_LOG, 'set\\n')
  process.exit(0)
}
process.exit(64)
`)
    await chmod(fakeHermes, 0o755)
    const environment = {
      ...process.env,
      HOME: directory,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_HOOKS: hooks,
      FAKE_HERMES_LOG: commandLog,
      CAIRN_HOOK_CLI: '/trusted/cairn-router',
      // A real OpenClaw on the developer's PATH must not be driven by this suite.
      CAIRN_OPENCLAW_BIN: 'openclaw-not-installed',
    }

    const first = await run('node', ['scripts/install-hooks.mjs'], environment)
    expect(first.code, first.stderr).toBe(0)
    const installed = JSON.parse(await readFile(hooks, 'utf8'))
    expect(installed.pre_tool_call).toEqual([{ command: '/existing/hook', timeout: 5 }])
    expect(installed.pre_llm_call).toHaveLength(1)
    expect(installed.pre_llm_call[0]).toMatchObject({ timeout: 10 })
    expect(installed.pre_llm_call[0].command).toContain('CAIRN_AGENT=hermes')
    expect(installed.pre_llm_call[0].command).toContain('CAIRN_CLI=/trusted/cairn-router')
    expect(installed.pre_llm_call[0].command).toContain('cairn-context.mjs')

    const second = await run('node', ['scripts/install-hooks.mjs'], environment)
    expect(second.code, second.stderr).toBe(0)
    expect((await readFile(commandLog, 'utf8')).trim().split('\n')).toHaveLength(1)

    const rejected = await run('node', ['scripts/install-hooks.mjs'], {
      ...environment,
      CAIRN_HOOK_CLI: 'router; not-a-command',
    })
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain('must be one safe executable path')
    expect((await readFile(commandLog, 'utf8')).trim().split('\n')).toHaveLength(1)

    const unavailable = await run('node', ['scripts/install-hooks.mjs'], {
      ...environment,
      FAKE_HERMES_GET_FAILURE: '1',
    })
    expect(unavailable.code).toBe(1)
    expect(unavailable.stderr).toContain('requires Hermes Agent by Nous Research v0.21.3 or newer')

    // `config set` exits 0 and writes nothing. Trusting the status would report
    // a hook that is not there; reading the config back is what catches it.
    await writeFile(hooks, JSON.stringify({ pre_tool_call: [{ command: '/existing/hook', timeout: 5 }] }))
    const discarded = await run('node', ['scripts/install-hooks.mjs'], {
      ...environment,
      FAKE_HERMES_SET_DISCARDS: '1',
    })
    expect(discarded.code).toBe(1)
    expect(discarded.stderr).toContain('reported success but the hook is not in the config it reads back')
    expect(discarded.stdout).not.toContain('briefing on first turn')
    expect(JSON.parse(await readFile(hooks, 'utf8')).pre_llm_call).toBeUndefined()
  })

  it('injects the Cairn briefing only for Hermes first turns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cairn-hermes-context-test-'))
    temporaryDirectories.push(directory)
    const fakeCairn = join(directory, 'cairn')
    await writeFile(fakeCairn, '#!/bin/sh\nprintf "## Cairn [MES]\\nKnown here: affiliate governance\\n"\n')
    await chmod(fakeCairn, 0o755)
    const environment = { ...process.env, CAIRN_CLI: fakeCairn }

    const first = await run('node', ['hooks/cairn-context.mjs'], environment, JSON.stringify({
      hook_event_name: 'pre_llm_call',
      cwd: '/project',
      extra: { is_first_turn: true },
    }))
    expect(first.code).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({ context: '## Cairn [MES]\nKnown here: affiliate governance' })

    const later = await run('node', ['hooks/cairn-context.mjs'], environment, JSON.stringify({
      hook_event_name: 'pre_llm_call',
      cwd: '/project',
      extra: { is_first_turn: false },
    }))
    expect(later.code).toBe(0)
    expect(later.stdout).toBe('')

    const compatibilityFirstTurn = await run('node', ['hooks/cairn-context.mjs'], environment, JSON.stringify({
      hook_event_name: 'pre_llm_call',
      cwd: '/project',
      is_first_turn: true,
    }))
    expect(compatibilityFirstTurn.code).toBe(0)
    expect(JSON.parse(compatibilityFirstTurn.stdout)).toEqual({ context: '## Cairn [MES]\nKnown here: affiliate governance' })

    // Neither location carries the key: no briefing is possible, so say so
    // rather than look like an ordinary later turn.
    const missing = await run('node', ['hooks/cairn-context.mjs'], environment, JSON.stringify({
      hook_event_name: 'pre_llm_call',
      cwd: '/project',
      extra: {},
    }))
    expect(missing.code).toBe(0)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('carries no is_first_turn')
  })
})
