import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Hand-off and sync: a task leaves this instance for another Cairn or for
 * GitHub, the link is recorded here, and `cairn sync` reads the status back.
 *
 * Two real servers stand in for two instances (the destination over TLS,
 * because the server only records an https URL for a Cairn), with a
 * ~/.cairn/instances.json naming both, so the CLI's own multi-instance routing
 * and its own `add` and `show` for the other side are what run. `gh` is a
 * script that logs what it was asked.
 *
 * The key and certificate are a throwaway pair for 127.0.0.1, valid for a
 * century and trusted by nothing; the CLI under test is run with
 * NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
const KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIKy9YdP9Qf3xNh/Bu4rEZL52aezPrH4BtHHZFafA9qvxoAoGCCqGSM49
AwEHoUQDQgAEIiq4Y0xMvg1xhKjuzBmAtb6/zZ4ElirNXq20q0OBhrFf+nGmmyqN
ouLiKhbWqRqf2awxQxzbhqkq1WKMLRX1cw==
-----END EC PRIVATE KEY-----`
const CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIUSgveh4K1Nh09dnIfQiyd+blmaNowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAxMDIwNDgxM1oYDzIxMjYwOTE2
MjA0ODEzWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQiKrhjTEy+DXGEqO7MGYC1vr/NngSWKs1erbSrQ4GGsV/6caabKo2i
4uIqFtapGp/ZrDFDHNuGqSrVYowtFfVzo2QwYjAdBgNVHQ4EFgQUXTDidfwxcu4W
y0Lm5Q9XqCFh1XMwHwYDVR0jBBgwFoAUXTDidfwxcu4Wy0Lm5Q9XqCFh1XMwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC
IQD1VTFE3Idb5N+FOWm8S1FQTeSdAG+LWPq6u6n+qrHBqwIgc2k1FmQwHrr969j5
df+QhqNqzG57DI9XIPc2C5imBGM=
-----END CERTIFICATE-----`

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method: string; path: string; body: Record<string, unknown> | null }
type Failure = { status: number; fail: Record<string, unknown> }
type Reply = unknown

const serve = (answer: (seen: Seen) => Reply, { secure = false } = {}) => {
  const seen: Seen[] = []
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      const entry = { method: req.method ?? 'GET', path: req.url ?? '', body: raw ? JSON.parse(raw) : null }
      seen.push(entry)
      const given = answer(entry) as Partial<Failure> | undefined
      if (given && typeof given === 'object' && 'fail' in given) {
        res.writeHead(given.status ?? 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, ...given.fail }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: given }))
    })
  }
  const server = secure ? createSecureServer({ key: KEY, cert: CERT }, handler) : createServer(handler)
  servers.push(server as unknown as Server)
  const url = new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`${secure ? 'https' : 'http'}://127.0.0.1:${(server.address() as { port: number }).port}`),
    ),
  )
  return { seen, url: () => url }
}

const sourceTask = {
  ref: 'CAIRN-12',
  number: 12,
  title: 'Wire the relay',
  description: '## Why\n- it drops frames',
  type: 'bug',
  priority: 'high',
  status: 'todo',
  handoff: null,
}

/** The destination instance: a project KDP that files, searches and shows. */
const destination = (extra: (s: Seen) => Reply = () => undefined) =>
  serve(
    (s) => {
      const own = extra(s)
      if (own !== undefined) return own
      if (s.path.startsWith('/api/v1/search')) return { results: [] }
      if (s.path === '/api/v1/projects') return [{ key: 'KDP' }]
      if (s.method === 'POST' && s.path === '/api/v1/projects/KDP/tasks') {
        return { ref: 'KDP-41', number: 41, title: s.body?.title, status: 'todo' }
      }
      if (s.path.startsWith('/api/v1/tasks/KDP-41')) {
        return { ref: 'KDP-41', status: 'done', resolution: 'Shipped in 0.4', resolutionKind: 'fixed' }
      }
      if (s.path.startsWith('/api/v1/handoffs')) return []
      return {}
    },
    { secure: true },
  )

const world = async (
  source: (s: Seen) => Reply,
  dest: ReturnType<typeof destination> = destination(),
  { destUrl, ghView = '{}' }: { destUrl?: string; ghView?: string } = {},
) => {
  const src = serve(source)
  const srcUrl = await src.url()
  const destBase = destUrl ?? (await dest.url())
  const home = await mkdtemp(join(tmpdir(), 'cairn-handoff-'))
  directories.push(home)
  await mkdir(join(home, '.cairn', 'instances', 'src'), { recursive: true })
  await mkdir(join(home, '.cairn', 'instances', 'dest'), { recursive: true })
  await writeFile(join(home, '.cairn', 'instances', 'src', 'env'), 'CAIRN_API_KEY=k-src\n')
  await writeFile(join(home, '.cairn', 'instances', 'dest', 'env'), 'CAIRN_API_KEY=k-dest\n')
  await writeFile(
    join(home, '.cairn', 'instances.json'),
    JSON.stringify({
      version: 1,
      instances: { src: { url: srcUrl }, dest: { url: destBase } },
      unclassified: { mode: 'default', instance: 'src' },
    }),
  )
  const bin = join(home, 'gh.mjs')
  const ghLog = join(home, 'gh.log')
  await writeFile(
    bin,
    `import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const create = args[0] === 'issue' && args[1] === 'create'
appendFileSync(process.env.GH_LOG, JSON.stringify({ args, stdin: create ? readFileSync(0, 'utf8') : '' }) + '\\n')
if (create) console.log('https://github.com/owner/repo/issues/7')
else console.log(process.env.GH_VIEW)
`,
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !['CAIRN_API_KEY', 'CAIRN_BASE_URL', 'CAIRN_INSTANCE'].includes(k)),
  ) as NodeJS.ProcessEnv
  const run = (args: string[], extraEnv: Record<string, string> = {}, instance: string[] = ['--instance', 'src']) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn('node', ['cli/cairn.mjs', ...instance, ...args], {
        env: {
          ...env,
          HOME: home,
          CAIRN_AGENT: 'test',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          CAIRN_GH_BIN: bin,
          GH_LOG: ghLog,
          GH_VIEW: ghView,
          ...extraEnv,
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      child.on('error', reject)
      child.on('close', (code) => resolve({ stdout, stderr, code }))
      child.stdin.end()
    })
  return { home, src, dest, run, ghLog, destUrl: destBase, srcUrl }
}

const posts = (seen: Seen[], suffix: string) => seen.filter((s) => s.method === 'POST' && s.path.endsWith(suffix))
const linkOk = { ref: 'CAIRN-12', id: 'u', subject: null, handoff: { tracker: 'cairn' }, status: 'todo', noted: false, closed: false }

/** The source instance: the task, its link endpoint, and whatever else a test overrides. */
const fromSource = (extra: (s: Seen) => Reply = () => undefined) => (s: Seen): Reply => {
  const own = extra(s)
  if (own !== undefined) return own
  if (s.method === 'GET' && s.path === '/api/v1/tasks/CAIRN-12') return sourceTask
  if (s.method === 'POST' && s.path.endsWith('/handoff')) return linkOk
  return []
}

describe('cairn handoff to another instance', () => {
  it('files the task there, links it here with the destination\'s absolute https URL', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'dest:KDP'])
    expect(out.code).toBe(0)

    const filed = posts(w.dest.seen, '/projects/KDP/tasks')[0]!
    expect(filed.body).toMatchObject({
      title: 'Wire the relay',
      type: 'bug',
      priority: 'high',
      externalRef: `${new URL(w.srcUrl).host}/CAIRN-12`,
      externalUrl: `${w.srcUrl}/projects/CAIRN/tasks/12`,
    })
    expect(String(filed.body!.description)).toContain('## Why\n- it drops frames')
    expect(String(filed.body!.description)).toContain(`Handed off from CAIRN-12: ${w.srcUrl}/projects/CAIRN/tasks/12`)
    // Filed, not claimed: the destination's work is for whoever picks it up there.
    expect(posts(w.dest.seen, '/claim')).toHaveLength(0)

    const linked = posts(w.src.seen, '/api/v1/tasks/CAIRN-12/handoff')
    expect(linked).toHaveLength(1)
    expect(linked[0]!.body).toEqual({ tracker: 'cairn', ref: 'KDP-41', url: `${w.destUrl}/projects/KDP/tasks/41` })
    expect(out.stdout).toContain('CAIRN-12\tcairn\tKDP-41\t')
    expect(out.stderr).toContain('filed KDP-41 in dest')
    expect(out.stderr).toContain('cairn sync')
  })

  it('refuses a destination that is not https before it files anything there', async () => {
    const plain = destination()
    const w = await world(fromSource(), plain, { destUrl: 'http://127.0.0.1:9' })
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'dest:KDP'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('is not https')
    expect(out.stderr).toContain('Nothing was filed')
    expect(plain.seen).toHaveLength(0)
    expect(posts(w.src.seen, '/handoff')).toHaveLength(0)
  })

  it('refuses to hand off to the instance it is on', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'src:KDP'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('src is this instance')
    expect(out.stderr).toContain('cairn update CAIRN-12 --project')
    expect(w.dest.seen).toHaveLength(0)
  })

  it('names the instances it has when --to names one it does not', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'cairn:nowhere:KDP'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('no instance named "nowhere"')
    expect(out.stderr).toContain('src, dest')
  })

  it('an earlier hand-off\'s task is not silently linked again', async () => {
    const dest = destination((s) =>
      s.method === 'POST' && s.path === '/api/v1/projects/KDP/tasks'
        ? { ref: 'KDP-41', number: 41, title: 'x', status: 'done', duplicate: true }
        : undefined,
    )
    const w = await world(fromSource(), dest)
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'dest:KDP'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('already has KDP-41 for CAIRN-12')
    expect(out.stderr).toContain('--link KDP-41 --to dest:KDP')
    expect(posts(w.src.seen, '/handoff')).toHaveLength(0)
  })

  it('when the link is refused after filing, says what to run to record it', async () => {
    const w = await world(
      fromSource((s) =>
        s.method === 'POST' && s.path.endsWith('/handoff')
          ? { status: 409, fail: { error: 'The project is archived.', code: 'conflict' } }
          : undefined,
      ),
    )
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'dest:KDP'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('KDP-41 was filed, but the link was refused: The project is archived.')
    expect(out.stderr).toContain(`cairn handoff CAIRN-12 --link KDP-41 --url ${w.destUrl}/projects/KDP/tasks/41 --to dest:KDP`)
  })

  it('uses the project\'s default when --to is left off', async () => {
    const w = await world(
      fromSource((s) =>
        s.method === 'GET' && s.path === '/api/v1/projects'
          ? [{ key: 'CAIRN', handoff_tracker: 'cairn', handoff_target: 'dest:KDP' }]
          : undefined,
      ),
    )
    const out = await w.run(['handoff', 'CAIRN-12'])
    expect(out.code).toBe(0)
    expect(out.stderr).toContain("CAIRN's hand-off default")
    expect(posts(w.src.seen, '/handoff')[0]!.body).toMatchObject({ tracker: 'cairn', ref: 'KDP-41' })
  })

  it('a default of <instance>/KEY names the instance; a bare KEY means the one other instance', async () => {
    for (const target of ['dest/KDP', 'KDP']) {
      const w = await world(
        fromSource((s) =>
          s.method === 'GET' && s.path === '/api/v1/projects'
            ? [{ key: 'CAIRN', handoff_tracker: 'cairn', handoff_target: target }]
            : undefined,
        ),
      )
      const out = await w.run(['handoff', 'CAIRN-12'])
      expect(out.code, out.stderr).toBe(0)
      expect(posts(w.src.seen, '/handoff')[0]!.body).toMatchObject({ tracker: 'cairn', ref: 'KDP-41' })
      expect(out.stderr).toContain('filed KDP-41 in dest')
    }
  })

  it('a bare key with several other instances asks which', async () => {
    const w = await world(
      fromSource((s) =>
        s.method === 'GET' && s.path === '/api/v1/projects'
          ? [{ key: 'CAIRN', handoff_tracker: 'cairn', handoff_target: 'KDP' }]
          : undefined,
      ),
    )
    const { writeFile: write } = await import('node:fs/promises')
    await write(
      join(w.home, '.cairn', 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: { src: { url: w.srcUrl }, dest: { url: w.destUrl }, other: { url: 'https://other.example.test' } },
        unclassified: { mode: 'default', instance: 'src' },
      }),
    )
    const out = await w.run(['handoff', 'CAIRN-12'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('which instance holds KDP?')
    expect(out.stderr).toContain('cairn handoff CAIRN-12 --to <instance>:KDP')
    expect(w.dest.seen).toHaveLength(0)
  })

  it('says where to go when there is no --to and no default', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('has nowhere to go')
    expect(out.stderr).toContain('--to <instance>:<KEY>')
  })

  it('refuses a task that is already handed off, and --undo takes it back', async () => {
    const handed = {
      ...sourceTask,
      handoff: { tracker: 'cairn', ref: 'KDP-41', url: 'https://x.test/projects/KDP/tasks/41', status: 'doing' },
    }
    const w = await world(
      fromSource((s) => {
        if (s.method === 'GET' && s.path === '/api/v1/tasks/CAIRN-12') return handed
        if (s.method === 'DELETE') return { ...sourceTask, status: 'todo' }
        return undefined
      }),
    )
    const refused = await w.run(['handoff', 'CAIRN-12', '--to', 'dest:KDP'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('already handed off to cairn as KDP-41 (doing)')
    expect(w.dest.seen).toHaveLength(0)

    const undone = await w.run(['handoff', 'CAIRN-12', '--undo'])
    expect(undone.code).toBe(0)
    expect(w.src.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/tasks/CAIRN-12/handoff' })
    expect(undone.stderr).toContain('nothing was done in the other tracker')
  })
})

describe('cairn project handoff', () => {
  const projectRoutes = (s: Seen): Reply =>
    s.method === 'GET' && s.path === '/api/v1/projects'
      ? [{ key: 'CAIRN', handoff_tracker: 'github', handoff_target: 'owner/repo' }]
      : { key: 'CAIRN' }

  it('sets the default: a Cairn by instance and key, GitHub by repository', async () => {
    const w = await world(projectRoutes)
    await w.run(['project', 'handoff', 'CAIRN', '--to', 'dest:kdp'])
    await w.run(['project', 'handoff', 'CAIRN', '--to', 'github:owner/repo'])
    await w.run(['project', 'handoff', 'CAIRN', '--to', 'cairn:KDP'])
    const patches = w.src.seen.filter((s) => s.method === 'PATCH')
    expect(patches.map((p) => p.path)).toEqual(Array(3).fill('/api/v1/projects/CAIRN'))
    expect(patches.map((p) => p.body)).toEqual([
      { handoffTracker: 'cairn', handoffTarget: 'dest/KDP' },
      { handoffTracker: 'github', handoffTarget: 'owner/repo' },
      { handoffTracker: 'cairn', handoffTarget: 'KDP' },
    ])
  })

  it('--clear removes both, and a bare call shows what is set', async () => {
    const w = await world(projectRoutes)
    await w.run(['project', 'handoff', 'CAIRN', '--clear'])
    expect(w.src.seen.find((s) => s.method === 'PATCH')!.body).toEqual({ handoffTracker: null, handoffTarget: null })
    const shown = await w.run(['project', 'handoff', 'CAIRN'])
    expect(shown.stdout.trim().split('\n')).toEqual(['#1', 'project\ttracker\ttarget', 'CAIRN\tgithub\towner/repo'])
  })

  it('refuses a target that would not be recorded, before asking', async () => {
    const w = await world(projectRoutes)
    const repo = await w.run(['project', 'handoff', 'CAIRN', '--to', 'github:--web'])
    expect(repo.code).toBe(1)
    expect(repo.stderr).toContain('is not a repository')
    const key = await w.run(['project', 'handoff', 'CAIRN', '--to', 'dest:not a key'])
    expect(key.code).toBe(1)
    expect(key.stderr).toContain('is not a project key')
    expect(w.src.seen.filter((s) => s.method === 'PATCH')).toHaveLength(0)
  })
})

describe('cairn handoff --link', () => {
  it('derives the destination URL from a named instance', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--link', 'KDP-41', '--to', 'dest:KDP'])
    expect(out.code).toBe(0)
    expect(posts(w.src.seen, '/handoff')[0]!.body).toEqual({
      tracker: 'cairn',
      ref: 'KDP-41',
      url: `${w.destUrl}/projects/KDP/tasks/41`,
    })
    expect(w.dest.seen).toHaveLength(0)
  })

  it('a bare Cairn ref with no URL is refused: it would not say which instance holds it', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--link', 'KDP-41'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('absolute https URL')
    expect(posts(w.src.seen, '/handoff')).toHaveLength(0)
  })

  it('takes an explicit URL as it is', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--link', 'KDP-41', '--to', 'cairn:work:KDP', '--url', 'https://tasks.example.test/projects/KDP/tasks/41'])
    expect(out.code).toBe(0)
    expect(posts(w.src.seen, '/handoff')[0]!.body).toEqual({
      tracker: 'cairn',
      ref: 'KDP-41',
      url: 'https://tasks.example.test/projects/KDP/tasks/41',
    })
  })

  it('knows a GitHub issue by its shape, and gives it its address', async () => {
    const w = await world(fromSource())
    await w.run(['handoff', 'CAIRN-12', '--link', 'owner/repo#3'])
    expect(posts(w.src.seen, '/handoff')[0]!.body).toEqual({
      tracker: 'github',
      ref: 'owner/repo#3',
      url: 'https://github.com/owner/repo/issues/3',
    })
  })

  it('records a tracker with no adapter, by the name given', async () => {
    const w = await world(fromSource())
    await w.run(['handoff', 'CAIRN-12', '--link', 'ENG-9', '--to', 'linear:ENG', '--url', 'https://linear.example.test/ENG-9'])
    expect(posts(w.src.seen, '/handoff')[0]!.body).toEqual({
      tracker: 'linear',
      ref: 'ENG-9',
      url: 'https://linear.example.test/ENG-9',
    })
  })

  it('will not file at a tracker it has no adapter for', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'linear:ENG'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('no adapter for "linear"')
    expect(out.stderr).toContain('--link <REF>')
  })
})

describe('cairn handoff to github', () => {
  it('files an issue with gh and links it', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'github:owner/repo'])
    expect(out.code).toBe(0)
    const [call] = (await readFile(w.ghLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(call.args).toEqual(['issue', 'create', '--repo=owner/repo', '--title=Wire the relay', '--body-file', '-'])
    expect(call.stdin).toContain('## Why\n- it drops frames')
    expect(call.stdin).toContain(`Handed off from CAIRN-12: ${w.srcUrl}/projects/CAIRN/tasks/12`)
    expect(posts(w.src.seen, '/handoff')[0]!.body).toEqual({
      tracker: 'github',
      ref: 'owner/repo#7',
      url: 'https://github.com/owner/repo/issues/7',
    })
    expect(w.dest.seen).toHaveLength(0)
  })

  it('refuses a repository that is not owner/repo', async () => {
    const w = await world(fromSource())
    const out = await w.run(['handoff', 'CAIRN-12', '--to', 'github:--web'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('is not a repository')
  })
})

describe('cairn sync', () => {
  const open = (destUrl: string) => [
    {
      ref: 'CAIRN-12', title: 'a', status: 'todo', subject: null,
      handoff: { tracker: 'cairn', ref: 'KDP-41', url: `${destUrl}/projects/KDP/tasks/41`, status: 'doing' },
    },
    {
      ref: 'CAIRN-13', title: 'b', status: 'todo', subject: 'LAB-2',
      handoff: { tracker: 'github', ref: 'owner/repo#7', url: 'https://github.com/owner/repo/issues/7', status: 'todo' },
    },
    {
      ref: 'CAIRN-14', title: 'c', status: 'todo', subject: null,
      handoff: { tracker: 'linear', ref: 'ENG-1', url: null, status: null },
    },
  ]

  it('reads each tracker back and records what it said, ending a done task with its resolution', async () => {
    const dest = destination()
    const destUrl = await dest.url()
    const w = await world(
      (s) => {
        if (s.path.startsWith('/api/v1/handoffs')) return open(destUrl)
        if (s.method === 'POST' && s.path.endsWith('/handoff')) {
          return { ...linkOk, noted: true, closed: s.path.includes('CAIRN-12') }
        }
        return []
      },
      dest,
      { ghView: JSON.stringify({ state: 'OPEN', stateReason: '', url: 'https://github.com/owner/repo/issues/7' }) },
    )
    const out = await w.run(['sync'])
    expect(out.code).toBe(0)

    expect(w.src.seen.find((s) => s.path.startsWith('/api/v1/handoffs'))!.path).toBe('/api/v1/handoffs?state=open')
    const sent = posts(w.src.seen, '/handoff')
    expect(sent.map((s) => s.path)).toEqual(['/api/v1/tasks/CAIRN-12/handoff', '/api/v1/tasks/CAIRN-13/handoff'])
    expect(sent[0]!.body).toEqual({
      tracker: 'cairn', ref: 'KDP-41', status: 'done', resolution: 'Shipped in 0.4', resolutionKind: 'fixed',
    })
    expect(sent[1]!.body).toEqual({ tracker: 'github', ref: 'owner/repo#7', status: 'todo' })

    const rows = out.stdout.trim().split('\n')
    expect(rows[1]).toBe('ref\ttracker\thandoff\tstatus\tresult')
    expect(rows[2]).toBe('CAIRN-12\tcairn\tKDP-41\tdone\twas doing · noted · closed')
    expect(rows[3]).toBe('CAIRN-13\tgithub\towner/repo#7\ttodo\tunchanged · noted')
    expect(rows[4]).toBe('CAIRN-14\tlinear\tENG-1\t\tskipped: no linear adapter on this machine')
  })

  it('reads a closed issue as done, or as cancelled when it was not planned', async () => {
    const closed = (reason: string) =>
      JSON.stringify({ state: 'CLOSED', stateReason: reason, url: 'https://github.com/owner/repo/issues/7' })
    const only = [
      { ref: 'CAIRN-13', title: 'b', status: 'todo', subject: null, handoff: { tracker: 'github', ref: 'owner/repo#7', url: null, status: 'todo' } },
    ]
    const answer = (s: Seen) => (s.path.startsWith('/api/v1/handoffs') ? only : linkOk)

    const done = await world(answer, destination(), { ghView: closed('COMPLETED') })
    await done.run(['sync'])
    expect(posts(done.src.seen, '/handoff')[0]!.body).toMatchObject({
      status: 'done', resolution: 'closed as completed', url: 'https://github.com/owner/repo/issues/7',
    })

    const dropped = await world(answer, destination(), { ghView: closed('NOT_PLANNED') })
    await dropped.run(['sync'])
    expect(posts(dropped.src.seen, '/handoff')[0]!.body).toMatchObject({
      status: 'cancelled', resolution: 'closed as not planned', resolutionKind: 'wont-fix',
    })
  })

  it('a destination no configured instance serves is that row\'s answer, not a failure', async () => {
    const w = await world((s) =>
      s.path.startsWith('/api/v1/handoffs')
        ? [
            {
              ref: 'CAIRN-12', title: 'a', status: 'todo', subject: null,
              handoff: { tracker: 'cairn', ref: 'KDP-41', url: 'https://elsewhere.example.test/projects/KDP/tasks/41', status: 'doing' },
            },
          ]
        : linkOk,
    )
    const out = await w.run(['sync'])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('unread: no configured instance serves https://elsewhere.example.test')
    expect(posts(w.src.seen, '/handoff')).toHaveLength(0)
  })

  it('one task the server refuses does not end the run', async () => {
    const dest = destination()
    const destUrl = await dest.url()
    const w = await world(
      (s) => {
        if (s.path.startsWith('/api/v1/handoffs')) return open(destUrl).slice(0, 2)
        if (s.method === 'POST' && s.path.includes('CAIRN-12')) {
          return { status: 409, fail: { error: 'The project is archived.', code: 'conflict' } }
        }
        return linkOk
      },
      dest,
      { ghView: JSON.stringify({ state: 'OPEN', url: null }) },
    )
    const out = await w.run(['sync'])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('refused: The project is archived.')
    expect(out.stdout).toContain('CAIRN-13\tgithub')
  })

  it('--all-instances asks every instance on the machine, each under its own key', async () => {
    const dest = destination()
    const w = await world((s) => (s.path.startsWith('/api/v1/handoffs') ? [] : []), dest)
    const out = await w.run(['sync', '--all-instances'], {}, [])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('== instance src ==')
    expect(out.stdout).toContain('== instance dest ==')
    expect(w.src.seen.some((s) => s.path.startsWith('/api/v1/handoffs'))).toBe(true)
    expect(dest.seen.some((s) => s.path.startsWith('/api/v1/handoffs'))).toBe(true)
  })

  it('--all-instances is refused beside --instance, as it is for the other maintenance verbs', async () => {
    const w = await world(() => [])
    const out = await w.run(['sync', '--all-instances'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('contradict')
  })
})
