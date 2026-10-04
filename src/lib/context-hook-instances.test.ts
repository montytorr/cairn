import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CAIRN-297. With several instances and no route for the directory, `cairn
 * context` exits 10 and says on stderr what to ask the user. That is the one
 * failure the briefing hook must not swallow: an agent told nothing finds out
 * at its first write, after the moment to ask has passed.
 */
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const script = async (dir: string, name: string, body: string) => {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const hook = async (cairnScript: string, { env = {}, trig, event = 'SessionStart' }: {
  env?: Record<string, string>
  trig?: string
  event?: string
} = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-context-hook-'))
  directories.push(dir)
  const cli = await script(dir, 'cairn', cairnScript)
  const siblings = {
    TRIG_CLI: trig ? await script(dir, 'trig', trig) : join(dir, 'no-trig'),
  }
  return new Promise<{ code: number | null; stdout: string; dir: string; context: () => string }>((resolve) => {
    const child = spawn('node', ['hooks/cairn-context.mjs'], {
      env: { ...process.env, CAIRN_CLI: cli, ...siblings, ...env },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('close', (code) => resolve({
      code,
      stdout,
      dir,
      context: () => JSON.parse(stdout).hookSpecificOutput.additionalContext,
    }))
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: '/work/client-site', tool_input: { file_path: '/work/client-site/a.ts' } }))
  })
}

describe('the briefing hook on a machine with several instances', () => {
  it("passes on the CLI's instruction to ask when the directory has no instance", async () => {
    const { code, stdout } = await hook('echo "cairn: nothing says which one ~/work/client-site is for. Ask the user" >&2; exit 10')
    expect(code).toBe(0)
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('Ask the user')
  })

  it('stays silent on any other failure, as before', async () => {
    const { stdout } = await hook('echo "boom" >&2; exit 1')
    expect(stdout).toBe('')
  })
})

/**
 * Trig's line rides at the end of Cairn's block: same deadline, same silence.
 * Nothing else is appended, whatever else is installed on the machine.
 */
describe('the briefing hook with a sibling product', () => {
  const CAIRN = 'printf "## Cairn [ACME]\\nHolding ACME-1\\n"'
  const TRIG_LINE = 'Trig — the map of what exists (scanned within the hour):\n  trig what-is <thing> · trig impact <thing> · trig inbox'

  it("appends Trig's line after Cairn's block", async () => {
    const finishedAt = new Date().toISOString()
    const { code, context } = await hook(CAIRN, { trig: `printf '[{"finishedAt":"${finishedAt}"}]'` })
    expect(code).toBe(0)
    expect(context()).toBe(`## Cairn [ACME]\nHolding ACME-1\n${TRIG_LINE}`)
  })

  it('says only Cairn\'s block when Trig is absent, failing, silent or slow', async () => {
    for (const trig of [undefined, 'exit 2', 'exit 0', 'sleep 5; echo "[]"']) {
      const started = Date.now()
      const { code, context } = await hook(CAIRN, { trig, env: { CAIRN_TRIG_TIMEOUT_MS: '200' } })
      expect(code).toBe(0)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(context()).toBe('## Cairn [ACME]\nHolding ACME-1')
    }
  })

  it('asks Trig nothing inside a summariser, or on a question about one file', async () => {
    const asked = 'touch "$(dirname "$0")/asked"; echo "[]"'
    for (const flag of ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']) {
      const run = await hook(CAIRN, { env: { [flag]: '1' }, trig: asked })
      expect(run.context()).toBe('## Cairn [ACME]\nHolding ACME-1')
      expect(existsSync(join(run.dir, 'asked'))).toBe(false)
    }
    const read = await hook(CAIRN, { event: 'PreToolUse', trig: asked })
    expect(read.context()).toBe('## Cairn [ACME]\nHolding ACME-1')
    expect(existsSync(join(read.dir, 'asked'))).toBe(false)
  })
})
