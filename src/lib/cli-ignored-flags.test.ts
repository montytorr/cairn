import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * KNOWN_FLAGS is one list for every verb, which is what makes it cheap and
 * what makes it blind: it catches a flag nothing reads, never a flag one verb
 * reads and another does not. `cairn relearn <slug> --global` parsed, printed
 * the entry with its old scope still on it and exited 0 — three lines below
 * the comment explaining why a silently dropped flag is unacceptable
 * (CAIRN-262).
 *
 * The guard is not a per-verb table. `flags` is a proxy that records what the
 * running command actually looked at, so the reads are the registry: exact,
 * and nothing to keep in step.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

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
        res.end(JSON.stringify({ success: true, data: { count: 0, results: [], slug: 'a-fact' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-ignored-'))
  directories.push(home)
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr, stdout }))
  })
}

describe('a flag the running command never read', () => {
  it('refuses a read that ignored one, because nothing has happened yet', async () => {
    const base = await serve({})
    const { code, stderr } = await run(['check', 'anything', '--mine'], base)

    expect(code).toBe(2)
    expect(stderr).toContain('`check` does not take --mine')
    expect(stderr).toContain('looks filtered and is not')
  })

  /**
   * The opposite call, and the reason this is not simply "exit 2 on an ignored
   * flag": the write already went through. An exit code saying otherwise is how
   * a caller ends up making it twice.
   */
  it('warns but succeeds on a write that ignored one', async () => {
    const seen: { method?: string } = {}
    const base = await serve(seen)
    const { code, stderr } = await run(['note', 'CAI-1', 'a note', '--priority', 'high'], base)

    expect(seen.method).toBe('POST')
    expect(code).toBe(0)
    expect(stderr).toContain('`note` does not take --priority')
    expect(stderr).toContain('went through WITHOUT it')
  })

  it('says nothing when every flag was read', async () => {
    const base = await serve({})
    const { code, stderr } = await run(['check', 'anything', '--kinds', 'knowledge'], base)

    expect(code).toBe(0)
    expect(stderr).not.toContain('does not take')
  })

  /**
   * --json and --pretty are read at module load, before any command runs. If
   * the proxy only saw reads inside the verb they would be reported on every
   * single invocation, which would be the fastest possible way to teach
   * everyone to ignore this warning.
   */
  it('does not report the output flags, which are read before dispatch', async () => {
    const base = await serve({})
    const { code, stderr } = await run(['projects', '--json'], base)

    expect(code).toBe(0)
    expect(stderr).not.toContain('does not take')
  })

  it('keeps the warning off stdout, which callers parse', async () => {
    const base = await serve({})
    const { stdout } = await run(['check', 'anything', '--mine'], base)

    expect(stdout).not.toContain('does not take')
  })
})

/**
 * The instance that exposed all of the above. `--global` means something
 * different on a PATCH than on a POST: `learn` uses it to say "do not infer a
 * project from this directory", `relearn` has to actively clear what is there.
 */
describe('relearn --global', () => {
  it('clears both scopes, because a fact true everywhere has neither', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    const { code } = await run(['relearn', 'a-fact', '--global'], base)

    expect(code).toBe(0)
    expect(seen.body?.projects).toEqual([])
    // Clearing only projects would leave `relearn --global` producing a state
    // `learn --global` cannot.
    expect(seen.body?.entities).toEqual([])
  })

  it('refuses to be combined with a scope it contradicts', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    const { code, stderr } = await run(['relearn', 'a-fact', '--global', '--project', 'CAI'], base)

    expect(code).not.toBe(0)
    expect(stderr).toContain('--global means no project and no entity')
    // Nothing reached the wire: the contradiction is caught before the write.
    expect(seen.body).toBeUndefined()
  })

  /**
   * CAIRN-295. A PATCH touches only the side it is given, so moving a fact from
   * a project to an entity has to clear the project explicitly. `--entity X`
   * alone adds and keeps the project, which is right; `none` is the clear.
   */
  it('moves a fact from a project to an entity with --project none', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    const { code } = await run(['relearn', 'a-fact', '--entity', 'clawdius', '--project', 'none'], base)

    expect(code).toBe(0)
    expect(seen.body?.projects).toEqual([])
    expect(seen.body?.entities).toEqual(['clawdius'])
  })

  it('clears only the side named none, and leaves the other alone', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    const { code } = await run(['relearn', 'a-fact', '--entity', 'none'], base)

    expect(code).toBe(0)
    expect(seen.body?.entities).toEqual([])
    expect(seen.body).not.toHaveProperty('projects')
  })

  it('adds an entity without touching the project when none is not given', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    await run(['relearn', 'a-fact', '--entity', 'clawdius'], base)

    expect(seen.body?.entities).toEqual(['clawdius'])
    expect(seen.body).not.toHaveProperty('projects')
  })

  /** An empty value used to read as "not given" and be dropped without a word. */
  it('refuses an empty scope instead of silently ignoring it', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const base = await serve(seen)
    const { code, stderr } = await run(['relearn', 'a-fact', '--entity', 'clawdius', '--project', ''], base)

    expect(code).not.toBe(0)
    expect(stderr).toContain('--project needs a value')
    expect(stderr).toContain('none to clear it')
    expect(seen.body).toBeUndefined()
  })

  it('is offered by the help text, which is the contract people read', async () => {
    const base = await serve({})
    const { stdout } = await run(['help'], base)
    const relearn = stdout.split('\n').findIndex((l) => l.includes('cairn relearn'))

    expect(relearn).toBeGreaterThan(-1)
    expect(stdout.split('\n').slice(relearn, relearn + 2).join(' ')).toContain('--global')
  })
})

/**
 * A sweep, because the mechanism's risk is not that it misses something — it is
 * that it fires on a legitimate command and starts exiting 2 on every machine
 * at once. Each of these is a documented invocation whose every flag the verb
 * really does read; a false positive here is the failure that matters.
 *
 * `add`, `update`, `done`, `cancel`, `list` and `run` are the ones a static
 * analysis got wrong: they read their flags through `for (const k of [...])`
 * loops and `[flag, field]` pairs, so a grep for `flags.x` reports them as
 * ignored and the proxy does not.
 */
describe('documented invocations stay silent', () => {
  const invocations: string[][] = [
    ['add', 'A title', '--project', 'CAI', '--type', 'bug', '--priority', 'high', '--body', 'b', '--label', 'l'],
    ['update', 'CAI-1', '--title', 'T', '--status', 'doing', '--type', 'bug', '--priority', 'low'],
    ['update', 'CAI-1', '--also-project', 'HM'],
    ['done', 'CAI-1', '--resolution', 'r', '--kind', 'fixed'],
    ['done', 'CAI-1', '--duplicate-of', 'CAI-2', '--resolution', 'r'],
    ['cancel', 'CAI-1', '--resolution', 'r', '--kind', 'wont-fix'],
    ['list', 'CAI', '--status', 'doing', '--type', 'bug', '--label', 'l', '--mine', '--limit', '5'],
    ['run', 'CAI-1', 'npm test', '--status', 'passed', '--exit-code', '0', '--duration-ms', '10'],
    ['commit', 'CAI-1', 'abc1234', '--repo', '/tmp', '--branch', 'b', '--message', 'm'],
    ['note', 'CAI-1', 'text', '--kind', 'finding'],
    ['release', 'CAI-1', '--force'],
    ['checkpoint', 'CAI-1', '--summary', 's'],
    ['block', 'CAI-1', '--reason', 'r'],
    ['learn', 'A fact', '--body', 'b', '--global', '--label', 'l', '--task', 'CAI-1'],
    ['relearn', 'a-fact', '--body', 'b', '--title', 'T'],
    ['unlearn', 'a-fact', '--superseded-by', 'b-fact'],
    ['check', 'x', '--project', 'CAI', '--kinds', 'task'],
    ['check', 'x', '--tasks'],
    ['show', 'CAI-1', '--full'],
    ['projects', '--archived'],
  ]

  it.each(invocations.map((args) => [args.join(' '), args] as const))(
    'cairn %s',
    async (_label, args) => {
      const base = await serve({})
      const { stderr } = await run([...args], base)
      expect(stderr).not.toContain('does not take')
    },
  )
})

describe('context scope option', () => {
  it('passes the project scope to the context endpoint', async () => {
    const seen: { url?: string } = {}
    const base = await serve(seen)
    const { code, stderr } = await run(['context', '--scope', 'project', '--project', 'MES', '--json'], base)
    expect(code).toBe(0)
    expect(stderr).not.toContain('does not take')
    expect(new URL(seen.url!, base).searchParams.get('scope')).toBe('project')
    expect(new URL(seen.url!, base).searchParams.get('project')).toBe('MES')
  })

  it('does not change the default context request', async () => {
    const seen: { url?: string } = {}
    const base = await serve(seen)
    const { code } = await run(['context', '--project', 'MES', '--json'], base)
    expect(code).toBe(0)
    expect(new URL(seen.url!, base).searchParams.has('scope')).toBe(false)
  })

  it('rejects an unsupported scope before contacting the server', async () => {
    const seen: { url?: string } = {}
    const base = await serve(seen)
    const { code, stderr } = await run(['context', '--scope', 'workspace'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('--scope must be project or all')
    expect(seen.url).toBeUndefined()
  })
})
