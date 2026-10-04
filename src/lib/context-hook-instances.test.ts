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

const hook = async (cairnScript: string, { env = {}, event = 'SessionStart' }: {
  env?: Record<string, string>
  event?: string
} = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-context-hook-'))
  directories.push(dir)
  const cli = await script(dir, 'cairn', cairnScript)
  return new Promise<{ code: number | null; stdout: string; dir: string; context: () => string }>((resolve) => {
    const child = spawn('node', ['hooks/cairn-context.mjs'], {
      env: { ...process.env, CAIRN_CLI: cli, ...env },
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

/** Cairn's block is the whole briefing, whatever else is installed on the machine. */
describe('the briefing hook with other tools on PATH', () => {
  const CAIRN = 'printf "## Cairn [ACME]\\nHolding ACME-1\\n"'

  it('appends nothing beyond Cairn\'s block, even with a trig binary on PATH', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'cairn-context-path-'))
    directories.push(bin)
    await script(bin, 'trig', 'touch "$(dirname "$0")/asked"; echo \'[{"finishedAt":"2026-01-01T00:00:00Z"}]\'')
    const { code, context } = await hook(CAIRN, { env: { PATH: `${bin}:${process.env.PATH}` } })
    expect(code).toBe(0)
    expect(context()).toBe('## Cairn [ACME]\nHolding ACME-1')
    expect(existsSync(join(bin, 'asked'))).toBe(false)
  })
})
