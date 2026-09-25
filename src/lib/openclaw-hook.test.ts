import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import handler, { FILE_NAME, RULE } from '../../hooks/openclaw/cairn-briefing/handler'

/**
 * CAIRN-292: OpenClaw's briefing hook reached 0 of 406 sessions because it
 * lived where OpenClaw never looks, and the installer's advice pointed at
 * exactly that kind of place. The hook now ships from the repo and the
 * installer links it with OpenClaw's own command. Both halves are exercised
 * the way they run: the installer spawned against a fake `openclaw`, the
 * handler handed a bootstrap event against a fake `cairn`.
 */

const REPO = resolve(__dirname, '../..')
const NODE_DIR = dirname(process.execPath)
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`

const directories: string[] = []
const savedEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...savedEnv }
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn('node', ['scripts/install-hooks.mjs', ...args], { env: env as NodeJS.ProcessEnv, cwd: REPO })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })

/**
 * A stand-in `openclaw` that logs its argv and, for `hooks install --link`,
 * does what the real one does to its config: add the directory to extraDirs
 * and enable the hook. `FAKE_OPENCLAW_OLD` makes it an older release that
 * rejects `--force`; `FAKE_OPENCLAW_FAIL` makes it refuse outright.
 */
const fakeOpenclaw = async (bin: string) => {
  const path = join(bin, 'openclaw')
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_OPENCLAW_LOG, JSON.stringify(args) + '\\n')
if (process.env.FAKE_OPENCLAW_FAIL) { process.stderr.write('config is locked\\n'); process.exit(2) }
if (process.env.FAKE_OPENCLAW_OLD && args.includes('--force')) {
  process.stderr.write("error: unknown option '--force'\\n"); process.exit(1)
}
if (args[0] === 'hooks' && args[1] === 'install' && args[2] === '--link') {
  const file = path.join(process.env.HOME, '.openclaw', 'openclaw.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  cfg.hooks = cfg.hooks || {}
  const internal = (cfg.hooks.internal = cfg.hooks.internal || {})
  internal.enabled = true
  internal.load = { extraDirs: [...new Set([...((internal.load || {}).extraDirs || []), args[3]])] }
  internal.entries = { ...(internal.entries || {}), 'cairn-briefing': { enabled: true } }
  fs.writeFileSync(file, JSON.stringify(cfg))
  process.stdout.write('Linked hook path\\n')
  process.exit(0)
}
process.exit(64)
`,
  )
  await chmod(path, 0o755)
}

const setup = async () => {
  const home = await temp('cairn-openclaw-home-')
  const bin = await temp('cairn-openclaw-bin-')
  await fakeOpenclaw(bin)
  const log = join(home, 'openclaw.log')
  const env = { PATH: `${bin}:${BASE_PATH}`, HOME: home, FAKE_OPENCLAW_LOG: log }
  const calls = async () =>
    existsSync(log)
      ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []
  const hookDir = join(home, '.cairn/hooks/openclaw/cairn-briefing')
  return { home, env, calls, hookDir }
}

describe('the installer links the OpenClaw briefing hook', () => {
  it('copies the hook to a stable path, links it with OpenClaw’s own command, and asks for a restart', async () => {
    const { env, calls, hookDir } = await setup()
    const first = await run([], env)
    expect(first.code, first.stderr).toBe(0)

    expect(await calls()).toEqual([['hooks', 'install', '--link', hookDir, '--force']])
    for (const file of ['HOOK.md', 'handler.ts']) {
      expect(await readFile(join(hookDir, file), 'utf8')).toBe(
        await readFile(join(REPO, 'hooks/openclaw/cairn-briefing', file), 'utf8'),
      )
    }
    expect(first.stdout).toContain('restart the gateway')
    expect(first.stdout).not.toContain('there is no path to install to')

    // Linked and unchanged: nothing to run, nothing to restart.
    const second = await run([], env)
    expect(second.code, second.stderr).toBe(0)
    expect(await calls()).toHaveLength(1)
    expect(second.stdout).toContain('already linked')
    expect(second.stdout).not.toContain('restart the gateway')
  })

  it('says a changed handler needs a restart, without re-linking', async () => {
    const { env, calls, hookDir } = await setup()
    await run([], env)
    await writeFile(join(hookDir, 'handler.ts'), '// an older copy\n')
    const again = await run([], env)
    expect(again.code, again.stderr).toBe(0)
    expect(await calls()).toHaveLength(1)
    expect(again.stdout).toContain('handler updated')
    expect(again.stdout).toContain('restart the gateway')
  })

  it('prints the exact command on --dry-run and runs nothing', async () => {
    const { env, calls, hookDir } = await setup()
    const dry = await run(['--dry-run'], env)
    expect(dry.code, dry.stderr).toBe(0)
    expect(dry.stdout).toContain(`would run: openclaw hooks install --link ${hookDir} --force`)
    expect(await calls()).toEqual([])
    expect(existsSync(hookDir)).toBe(false)
  })

  it('retries without --force on an OpenClaw too old to know it', async () => {
    const { env, calls, hookDir } = await setup()
    const out = await run([], { ...env, FAKE_OPENCLAW_OLD: '1' })
    expect(out.code, out.stderr).toBe(0)
    expect(await calls()).toEqual([
      ['hooks', 'install', '--link', hookDir, '--force'],
      ['hooks', 'install', '--link', hookDir],
    ])
  })

  it('fails loudly, with the command to run by hand, when OpenClaw refuses', async () => {
    const { env } = await setup()
    const out = await run([], { ...env, FAKE_OPENCLAW_FAIL: '1' })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('config is locked')
    expect(out.stderr).toContain('run the command above by hand')
  })

  it('skips cleanly where OpenClaw is not installed', async () => {
    const { env, hookDir } = await setup()
    const out = await run([], { ...env, CAIRN_OPENCLAW_BIN: 'openclaw-not-installed' })
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('openclaw: not on PATH — skipped')
    expect(existsSync(hookDir)).toBe(false)
  })
})

describe('the OpenClaw briefing hook', () => {
  const fakeCairn = async (script: string) => {
    const bin = await temp('cairn-openclaw-cli-')
    const path = join(bin, 'cairn')
    await writeFile(path, `#!/usr/bin/env node\n${script}\n`)
    await chmod(path, 0o755)
    process.env.CAIRN_CLI = path
    return path
  }

  const bootstrap = (workspaceDir: string, files: unknown[] = []) => ({
    type: 'agent',
    action: 'bootstrap',
    context: { workspaceDir, bootstrapFiles: files as unknown[] },
  })

  it('injects the rule and the live briefing for the workspace, as openclaw', async () => {
    const workspace = await temp('cairn-openclaw-ws-')
    delete process.env.CAIRN_AGENT
    await fakeCairn(
      `process.stdout.write('## Cairn [ACME]\\nargs=' + process.argv.slice(2).join(' ') + '\\nagent=' + process.env.CAIRN_AGENT + '\\ncwd=' + process.cwd())`,
    )
    const soul = { name: 'SOUL.md', path: join(workspace, 'SOUL.md'), content: 'x', missing: false }
    const event = bootstrap(workspace, [soul])
    await handler(event)

    const files = event.context.bootstrapFiles as { name: string; path: string; content: string; missing: boolean }[]
    expect(files[0]).toBe(soul)
    const cairn = files.find((f) => f.name === FILE_NAME)
    expect(cairn?.missing).toBe(false)
    expect(cairn?.path).toBe(join(workspace, FILE_NAME))
    expect(cairn?.content.startsWith(RULE)).toBe(true)
    expect(cairn?.content).toContain(`args=context --cwd ${workspace}`)
    expect(cairn?.content).toContain('agent=openclaw')
    expect(cairn?.content).toContain('## Cairn [ACME]')
  })

  it('replaces its own file rather than stacking a second one', async () => {
    const workspace = await temp('cairn-openclaw-ws-')
    await fakeCairn(`process.stdout.write('live')`)
    const stale = { name: FILE_NAME, path: join(workspace, FILE_NAME), content: 'old', missing: false }
    const event = bootstrap(workspace, [stale])
    await handler(event)
    const files = event.context.bootstrapFiles as { name: string; content: string }[]
    expect(files.filter((f) => f.name === FILE_NAME)).toHaveLength(1)
    expect(files[0]?.content).toBe(`${RULE}\n\nlive`)
  })

  it('fails open to the rule alone when the CLI errors, is missing, or is slow', async () => {
    const workspace = await temp('cairn-openclaw-ws-')
    for (const setupCli of [
      () => fakeCairn(`process.stderr.write('no key'); process.exit(3)`),
      async () => { process.env.CAIRN_CLI = join(workspace, 'no-such-cairn') },
      async () => {
        process.env.CAIRN_HOOK_TIMEOUT_MS = '200'
        await fakeCairn(`setTimeout(() => process.stdout.write('late'), 5000)`)
      },
    ]) {
      await setupCli()
      const event = bootstrap(workspace)
      const started = Date.now()
      await handler(event)
      expect(Date.now() - started).toBeLessThan(3000)
      const files = event.context.bootstrapFiles as { name: string; content: string }[]
      expect(files).toHaveLength(1)
      expect(files[0]?.content).toBe(RULE)
    }
  })

  it('ignores every other event, and a bootstrap it cannot mutate', async () => {
    const workspace = await temp('cairn-openclaw-ws-')
    const marker = join(workspace, 'ran')
    await fakeCairn(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`)
    const command = { type: 'command', action: 'new', context: { workspaceDir: workspace, bootstrapFiles: [] as unknown[] } }
    await handler(command)
    expect(command.context.bootstrapFiles).toEqual([])
    await handler({ type: 'agent', action: 'bootstrap', context: { workspaceDir: workspace } })
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps the rule short, and in step with the lifecycle the skill teaches', async () => {
    expect(Buffer.byteLength(RULE)).toBeLessThan(1200)
    for (const needle of ['cairn check', 'claim', '--kind attempt', 'checkpoint', 'in-review', 'verified', '--global']) {
      expect(RULE).toContain(needle)
    }
    const hookMd = await readFile(join(REPO, 'hooks/openclaw/cairn-briefing/HOOK.md'), 'utf8')
    expect(hookMd).toMatch(/^---\nname: cairn-briefing\n/)
    expect(hookMd).toContain('"events": ["agent:bootstrap"]')
  })
})

describe('the skill and the agent guide', () => {
  it('fit the budgets that decide whether they are read', async () => {
    const skill = await readFile(join(REPO, 'skills/cairn/SKILL.md'))
    expect(skill.byteLength).toBeLessThanOrEqual(15_000)
    // The lifecycle has to be in what a partial read reaches.
    const head = skill.toString('utf8').split('\n').slice(0, 62).join('\n')
    expect(head).toMatch(/claims\s+by default/)
    for (const needle of ['cairn check', 'Exit 9', '--kind attempt', 'checkpoint', 'in-review', '`verified`', 'one claimed task per sweep', 'When not to file']) {
      expect(head).toContain(needle)
    }
  })

  it('do not promise what the code does not do', async () => {
    for (const file of ['skills/cairn/SKILL.md', 'AGENTS.md']) {
      const text = await readFile(join(REPO, file), 'utf8')
      expect(text, file).toContain('verified')
      expect(text, file).not.toMatch(/Any task you were still holding gets checkpointed/)
      expect(text, file).not.toMatch(/Release a claim only when handing work back unfinished/)
    }
  })
})
