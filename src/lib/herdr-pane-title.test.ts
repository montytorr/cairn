import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * What Herdr's sidebar shows for an agent pane: the Cairn task it holds, else
 * its session title, else the terminal title, else the agent name. The CLI
 * publishes the task; the plugin under hooks/herdr/pane-title resolves the rest.
 */
type Pane = {
  pane_id: string
  agent?: string
  terminal_title_stripped?: string
  tokens?: Record<string, string>
}
type Plugin = {
  cutOneLine: (text: string, width: number) => string
  splitTwo: (text: string, width: number) => [string, string]
  pickTitle: (pane: Pane, resolved?: string) => string
  codexTitle: (session: string, home: string) => string
  piTitle: (path: string) => string
  tabLabel: (tab: Tab, focused: Pane | null, title: string, last?: string, max?: number) => string | null
  focusedPaneOf: (panes: (Pane & { focused?: boolean })[], focusedId: (pane: Pane) => string | null) => Pane | null
  runExclusive: (sync: () => void, dir?: string) => void
  readLimits: (env: Record<string, string | undefined>, read?: (file: string) => string) => Record<string, number>
}
type Tab = { tab_id: string; number: number; label?: string }

const plugin = (await import(
  /* @vite-ignore */ pathToFileURL(resolve('hooks/herdr/pane-title/sync.mjs')).href
)) as Plugin

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-herdr-'))
  directories.push(dir)
  return dir
}

describe('title precedence', () => {
  const pane: Pane = {
    pane_id: 'w1:p1',
    agent: 'claude',
    terminal_title_stripped: 'user@host:~/repo',
    tokens: { cairn_task: 'CAIRN-15 · Nommer les panes' },
  }

  it('puts the Cairn task first', () => {
    expect(plugin.pickTitle(pane, 'Session title')).toBe('CAIRN-15 · Nommer les panes')
  })

  it('falls back to the resolved session title', () => {
    expect(plugin.pickTitle({ ...pane, tokens: {} }, 'Session title')).toBe('Session title')
  })

  it('then to the terminal title', () => {
    expect(plugin.pickTitle({ ...pane, tokens: {} })).toBe('user@host:~/repo')
  })

  it('then to the agent name', () => {
    expect(plugin.pickTitle({ pane_id: 'w1:p1', agent: 'pi', terminal_title_stripped: ' ' })).toBe('pi')
  })

  it('ignores a blank Cairn token', () => {
    expect(plugin.pickTitle({ ...pane, tokens: { cairn_task: '  ' } }, 'Session title')).toBe('Session title')
  })
})

describe('border and sidebar text', () => {
  it('leaves a short title alone', () => {
    expect(plugin.cutOneLine('CAIRN-15 · Short', 44)).toBe('CAIRN-15 · Short')
  })

  it('cuts on a word boundary with an ellipsis', () => {
    const cut = plugin.cutOneLine('CAIRN-15 · Nommer les panes Herdr avec la tache Cairn tenue', 30)
    expect(cut.length).toBeLessThanOrEqual(30)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('tenu')
  })

  it('keeps a short title on one row', () => {
    expect(plugin.splitTwo('CAIRN-15 · Short', 24)).toEqual(['CAIRN-15 · Short', ''])
  })

  it('balances two rows within the width', () => {
    const [a, b] = plugin.splitTwo('CAIRN-15 · Nommer les panes Herdr', 24)
    expect(`${a} ${b}`).toBe('CAIRN-15 · Nommer les panes Herdr'.replace(/\s+/g, ' '))
    expect(a.length).toBeLessThanOrEqual(24)
    expect(b.length).toBeLessThanOrEqual(24)
    expect(Math.abs(a.length - b.length)).toBeLessThan(10)
  })

  it('ends the second row with an ellipsis when two rows cannot hold it', () => {
    const [a, b] = plugin.splitTwo('CAIRN-15 · Nommer les panes Herdr avec la tache Cairn que tient chaque agent', 24)
    expect(a.length).toBeLessThanOrEqual(24)
    expect(b.length).toBeLessThanOrEqual(24)
    expect(b.endsWith('…')).toBe(true)
  })
})

describe('session title resolvers', () => {
  it('reads the first real Codex prompt, skipping the preamble', async () => {
    const home = await scratch()
    const day = join(home, '.codex', 'sessions', '2026', '09', '30')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, 'rollout-2026-09-30T10-00-00-abc123.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: {} }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix   the\nlogin  bug' } }),
      ].join('\n'),
    )
    expect(plugin.codexTitle('abc123', home)).toBe('Fix the login bug')
    expect(plugin.codexTitle('missing', home)).toBe('')
  })

  it('reads the first Pi user message from the session path', async () => {
    const dir = await scratch()
    const path = join(dir, 'session.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'no' }] } }),
        'not json',
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Port the plugin' }] } }),
      ].join('\n'),
    )
    expect(plugin.piTitle(path)).toBe('Port the plugin')
    expect(plugin.piTitle(join(dir, 'gone.jsonl'))).toBe('')
  })
})

describe('tab label', () => {
  const tab: Tab = { tab_id: 'w1:t2', number: 2, label: '2' }
  const agent: Pane = { pane_id: 'w1:p3', agent: 'claude' }
  const title = 'CAIRN-15 · Nommer les panes Herdr avec la tache'

  it('replaces the default number label with the focused pane title, cut on a word', () => {
    const label = plugin.tabLabel(tab, agent, title, undefined, 28)
    expect(label).toBe('CAIRN-15 · Nommer les panes…')
    expect(label?.length).toBeLessThanOrEqual(28)
  })

  it('replaces an empty label and the one it wrote last', () => {
    expect(plugin.tabLabel({ ...tab, label: '' }, agent, 'Short')).toBe('Short')
    expect(plugin.tabLabel({ ...tab, label: 'Old title' }, agent, 'New title', 'Old title')).toBe('New title')
  })

  it('never overwrites a label a person typed', () => {
    expect(plugin.tabLabel({ ...tab, label: 'deploy' }, agent, title, 'something else')).toBeNull()
    expect(plugin.tabLabel({ ...tab, label: 'deploy' }, agent, title)).toBeNull()
  })

  it('leaves the tab alone for a plain shell or an unchanged label', () => {
    expect(plugin.tabLabel(tab, { pane_id: 'w1:p3' }, 'zsh')).toBeNull()
    expect(plugin.tabLabel(tab, null, '')).toBeNull()
    expect(plugin.tabLabel({ ...tab, label: 'Short' }, agent, 'Short', 'Short')).toBeNull()
  })

  it('takes the only pane of a tab, else the one its layout says is focused', () => {
    const a: Pane = { pane_id: 'w1:p1' }
    const b: Pane = { pane_id: 'w1:p2' }
    const none = () => { throw new Error('no layout lookup for a single pane') }
    expect(plugin.focusedPaneOf([a], none)).toBe(a)
    expect(plugin.focusedPaneOf([a, b], () => 'w1:p2')).toBe(b)
    expect(plugin.focusedPaneOf([a, { ...b, focused: true }], () => null)).toMatchObject({ pane_id: 'w1:p2' })
    expect(plugin.focusedPaneOf([], none)).toBeNull()
  })
})

describe('the CLI publishes the claimed task to Herdr', () => {
  const serve = (title: string) =>
    new Promise<string>((done) => {
      const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          const tail = (req.url ?? '').split('/').pop()
          const data = tail === 'claim'
            ? { number: 15, title, status: 'doing', claimed_by: 'test' }
            : { number: 15, claimed_by: 'test', status: 'done' }
          res.end(JSON.stringify({ success: true, data }))
        })
      })
      servers.push(server)
      server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
    })

  const setup = async (title: string, herdrEnv: Record<string, string> = { HERDR_PANE_ID: 'w1:p1' }) => {
    const home = await scratch()
    const bin = join(home, 'bin')
    const log = join(home, 'herdr.log')
    await mkdir(bin)
    await writeFile(join(bin, 'herdr'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`)
    await chmod(join(bin, 'herdr'), 0o755)
    await writeFile(join(bin, 'hc'), `#!/bin/sh\nprintf 'hc %s\\n' "$*" >> "${log}"\n`)
    await chmod(join(bin, 'hc'), 0o755)
    const base = await serve(title)
    const cairn = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn('node', ['cli/cairn.mjs', ...args], {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            CAIRN_BASE_URL: base,
            CAIRN_API_KEY: 'test-key',
            CAIRN_AGENT: 'test',
            HERDR_PANE_ID: '',
            HC_TERMINAL_ID: '',
            CAIRN_HERDR: '',
            ...herdrEnv,
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
        child.on('error', fail)
        child.on('close', (code) => done({ code, stdout, stderr }))
      })
    const RESYNC = 'plugin action invoke sync --plugin cairn.pane-title'
    const reports = async () =>
      (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l && l !== RESYNC)
    const calls = async (wanted: number) => {
      for (let i = 0; i < 40; i += 1) {
        const lines = await reports()
        if (lines.length >= wanted) return lines
        await new Promise((r) => setTimeout(r, 50))
      }
      return reports()
    }
    return { cairn, calls, log }
  }

  it('reports the ref and title with a two-hour TTL after a claim, then refreshes on beat and checkpoint, then clears on release', async () => {
    const { cairn, calls, log } = await setup('Nommer les panes')
    const claimed = await cairn(['claim', 'CAIRN-15'])
    expect(claimed.code).toBe(0)
    expect(claimed.stdout).not.toContain('herdr')
    const lines = await calls(1)
    expect(lines[0]).toBe('pane report-metadata w1:p1 --source cairn --token cairn_task=CAIRN-15 · Nommer les panes --ttl-ms 7200000')
    await new Promise((r) => setTimeout(r, 200))
    expect(await readFile(log, 'utf8')).toContain(`${lines[0]}\nplugin action invoke sync --plugin cairn.pane-title\n`)

    await cairn(['beat', 'CAIRN-15'])
    expect((await calls(2))[1]).toBe(lines[0])

    await cairn(['checkpoint', 'CAIRN-15', '--summary', 'halfway'])
    expect((await calls(3))[2]).toBe(lines[0])

    await cairn(['release', 'CAIRN-15'])
    expect((await calls(4))[3]).toBe('pane report-metadata w1:p1 --source cairn --clear-token cairn_task')
  })

  it('leaves another task\'s label alone when a different ref is released', async () => {
    const { cairn, calls, log } = await setup('Nommer les panes')
    await cairn(['claim', 'CAIRN-15'])
    await calls(1)
    await cairn(['release', 'CAIRN-99'])
    await new Promise((r) => setTimeout(r, 300))
    expect(await calls(2)).toHaveLength(1)
  })

  it('labels an hc terminal, and clears only its own label', async () => {
    const { cairn, calls } = await setup('Nommer les panes', { HC_TERMINAL_ID: 'm1/t7' })
    const claimed = await cairn(['claim', 'CAIRN-15'])
    expect(claimed.code).toBe(0)
    expect(claimed.stdout).not.toContain('hc')
    const label = 'hc label m1/t7 cairn.task=CAIRN-15 · Nommer les panes'
    expect(await calls(1)).toEqual([label])
    await cairn(['beat', 'CAIRN-15'])
    expect(await calls(2)).toEqual([label, label])
    await cairn(['release', 'CAIRN-99'])
    await new Promise((r) => setTimeout(r, 300))
    expect(await calls(3)).toHaveLength(2)
    await cairn(['release', 'CAIRN-15'])
    expect((await calls(3))[2]).toBe('hc label m1/t7 cairn.task=')
  })

  it('labels both the hc terminal and the herdr pane when both are set, and clears both', async () => {
    const { cairn, calls } = await setup('Nommer les panes', { HC_TERMINAL_ID: 'm1/t7', HERDR_PANE_ID: 'w1:p1' })
    await cairn(['claim', 'CAIRN-15'])
    const claim = [
      'hc label m1/t7 cairn.task=CAIRN-15 · Nommer les panes',
      'pane report-metadata w1:p1 --source cairn --token cairn_task=CAIRN-15 · Nommer les panes --ttl-ms 7200000',
    ]
    expect((await calls(2)).sort()).toEqual(claim)
    await cairn(['beat', 'CAIRN-15'])
    expect((await calls(4)).slice(2).sort()).toEqual(claim)
    await cairn(['release', 'CAIRN-15'])
    expect((await calls(6)).slice(4).sort()).toEqual([
      'hc label m1/t7 cairn.task=',
      'pane report-metadata w1:p1 --source cairn --clear-token cairn_task',
    ])
  })

  it.each(['t1; touch x', '-x'])('ignores the hc terminal id %j and labels only the pane', async (id) => {
    const { cairn, calls } = await setup('Nommer les panes', { HC_TERMINAL_ID: id, HERDR_PANE_ID: 'w1:p1' })
    await cairn(['claim', 'CAIRN-15'])
    await new Promise((r) => setTimeout(r, 300))
    expect(await calls(1)).toEqual([
      'pane report-metadata w1:p1 --source cairn --token cairn_task=CAIRN-15 · Nommer les panes --ttl-ms 7200000',
    ])
  })

  it('truncates a long title', async () => {
    const { cairn, calls } = await setup('x'.repeat(300))
    await cairn(['claim', 'CAIRN-15'])
    const token = (await calls(1))[0]?.split(' --token ')[1]?.split(' --ttl-ms')[0] ?? ''
    expect(token.length).toBeLessThanOrEqual('cairn_task='.length + 120)
    expect(token.endsWith('…')).toBe(true)
  })

  it('does nothing outside Herdr or with CAIRN_HERDR=0', async () => {
    const envs = [
      { HERDR_PANE_ID: '' },
      { HERDR_PANE_ID: 'w1:p1', CAIRN_HERDR: '0' },
      { HC_TERMINAL_ID: 't7', CAIRN_HERDR: '0' },
    ] as Record<string, string>[]
    for (const env of envs) {
      const { cairn, log } = await setup('Nommer les panes', env)
      const claimed = await cairn(['claim', 'CAIRN-15'])
      expect(claimed.code).toBe(0)
      await new Promise((r) => setTimeout(r, 300))
      expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
    }
  })

  it.each([
    ['herdr', { HERDR_PANE_ID: 'w1:p1', HC_TERMINAL_ID: '' }],
    ['hc', { HC_TERMINAL_ID: 't7', HERDR_PANE_ID: '' }],
  ])('never fails a command when %s is missing', async (bin, herdrEnv) => {
    const home = await scratch()
    const without = (process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, bin))).join(':')
    const base = await serve('Nommer les panes')
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, ['cli/cairn.mjs', 'claim', 'CAIRN-15'], {
        env: { ...process.env, HOME: home, PATH: without, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'k', CAIRN_AGENT: 'test', ...herdrEnv },
      })
      child.stdout.resume()
      child.stderr.resume()
      child.on('close', done)
    })
    expect(code).toBe(0)
  })

  it('kills a hung herdr on its own deadline, after the command has exited', async () => {
    const { cairn, log } = await setup('Nommer les panes')
    const pids = `${log}.pids`
    await writeFile(join(log, '..', 'bin', 'herdr'), `#!/bin/sh\necho $$ >> "${pids}"\nexec sleep 60\n`)
    const started = Date.now()
    const claimed = await cairn(['claim', 'CAIRN-15'])
    expect(claimed.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
    let pid = 0
    for (let i = 0; i < 40 && !pid; i += 1) {
      pid = Number((await readFile(pids, 'utf8').catch(() => '')).trim().split('\n')[0]) || 0
      if (!pid) await new Promise((r) => setTimeout(r, 50))
    }
    expect(pid).toBeGreaterThan(0)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r) => setTimeout(r, 250))
    expect(alive()).toBe(false)
  }, 20_000)
})

describe('cairn setup and the Herdr plugin', () => {
  type Listed = { plugin_id: string; plugin_root?: string; version?: string; manifest_path?: string; source?: { kind: string } }
  type Setup = {
    PLUGIN_ID: string
    planHerdrPlugin: (input: { plugins: Listed[]; root: string; version: string }) => { action: string; reason: string }
    titleConflicts: (plugins: Listed[], read?: (file: string) => string | null) => Listed[]
  }
  const setup = (async () =>
    (await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/herdr-plugin.mjs')).href)) as Setup)()
  const root = '/opt/cairn/hooks/herdr/pane-title'
  const ours = { plugin_id: 'cairn.pane-title', plugin_root: root, version: '0.1.0' }

  it('links when the plugin is not installed, or is installed from somewhere else', async () => {
    const { planHerdrPlugin } = await setup
    expect(planHerdrPlugin({ plugins: [], root, version: '0.1.0' }).action).toBe('link')
    expect(planHerdrPlugin({ plugins: [{ ...ours, plugin_root: '/elsewhere' }], root, version: '0.1.0' }).action).toBe('link')
  })

  it('upgrades an older version and leaves the same one alone', async () => {
    const { planHerdrPlugin } = await setup
    expect(planHerdrPlugin({ plugins: [{ ...ours, version: '0.0.9' }], root, version: '0.1.0' }).action).toBe('link')
    expect(planHerdrPlugin({ plugins: [ours], root, version: '0.1.0' }).action).toBe('none')
  })

  it('names any plugin that writes the title rows, never Cairn\'s own', async () => {
    const { titleConflicts } = await setup
    const plugins: Listed[] = [
      ours,
      { plugin_id: 'someone.untitled' },
      { plugin_id: 'someone.titles', manifest_path: '/m/herdr-plugin.toml' },
      { plugin_id: 'zenbu.browser', manifest_path: '/b/herdr-plugin.toml' },
    ]
    const read = (file: string) => (file === '/m/herdr-plugin.toml' ? 'report --token title_l1=x' : 'nothing')
    expect(titleConflicts(plugins, read).map((p) => p.plugin_id)).toEqual(['someone.titles'])
  })
})

describe('one sync at a time', () => {
  it('runs again, once, for an event that arrived while a sync was running', async () => {
    const dir = await scratch()
    let runs = 0
    let nestedRan = false
    plugin.runExclusive(() => {
      runs += 1
      if (runs === 1) plugin.runExclusive(() => { nestedRan = true }, dir)
    }, dir)
    expect(nestedRan).toBe(false)
    expect(runs).toBe(2)
    expect(existsSync(join(dir, 'sync.lock'))).toBe(false)
    expect(existsSync(join(dir, 'sync.pending'))).toBe(false)
  })

  it('leaves a live lock alone and breaks a stale one', async () => {
    const dir = await scratch()
    await mkdir(join(dir, 'sync.lock'))
    let runs = 0
    plugin.runExclusive(() => { runs += 1 }, dir)
    expect(runs).toBe(0)
    expect(existsSync(join(dir, 'sync.pending'))).toBe(true)

    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 120_000)
    await utimes(join(dir, 'sync.lock'), old, old)
    plugin.runExclusive(() => { runs += 1 }, dir)
    expect(runs).toBe(1)
    expect(existsSync(join(dir, 'sync.lock'))).toBe(false)
  })

  it('never throws, and releases the lock, when the sync fails', async () => {
    const dir = await scratch()
    expect(() => plugin.runExclusive(() => { throw new Error('boom') }, dir)).not.toThrow()
    expect(existsSync(join(dir, 'sync.lock'))).toBe(false)
  })
})

describe('title widths', () => {
  const none = () => { throw new Error('ENOENT') }

  it('defaults without a config file or environment', () => {
    expect(plugin.readLimits({}, none)).toEqual({ paneTitleMax: 44, sidebarTitleWidth: 24, tabTitleMax: 28 })
  })

  it('prefers config.json over the environment, and ignores values that are not usable widths', () => {
    const read = (file: string) => (file === '/cfg/config.json' ? '{"sidebarTitleWidth": 34, "tabTitleMax": "wide", "paneTitleMax": 2}' : '')
    const env = { HERDR_PLUGIN_CONFIG_DIR: '/cfg', HERDR_SIDEBAR_TITLE_WIDTH: '30', HERDR_TAB_TITLE_MAX: '40' }
    expect(plugin.readLimits(env, read)).toEqual({ paneTitleMax: 44, sidebarTitleWidth: 34, tabTitleMax: 40 })
  })
})
