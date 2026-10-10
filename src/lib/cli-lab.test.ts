import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * The Lab in the CLI: subjects, ideas, stages and tags, the --subject flag on
 * the task verbs, and the briefing block. Every test talks to a server of its
 * own that answers what docs/lab.md says the real one does, and records what
 * it was asked, so the assertions are about the requests the CLI makes and
 * the words it prints.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method: string; path: string; body: Record<string, unknown> | null }
type Answer = { status?: number; body: unknown } | unknown

const serve = (answer: (seen: Seen) => Answer) => {
  const seen: Seen[] = []
  const started = new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        const entry = { method: req.method ?? 'GET', path: req.url ?? '', body: raw ? JSON.parse(raw) : null }
        seen.push(entry)
        const given = answer(entry) as { status?: number; fail?: Record<string, unknown>; data?: unknown } | undefined
        if (given && typeof given === 'object' && 'fail' in given) {
          res.writeHead(given.status ?? 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: false, ...given.fail }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: given && typeof given === 'object' && 'data' in given ? given.data : given }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })
  return { seen, base: () => started }
}

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-lab-'))
  directories.push(dir)
  return dir
}

const run = async (args: string[], base: string, options: { home?: string; stdin?: string } = {}) => {
  const dir = options.home ?? (await home())
  return new Promise<{ stdout: string; stderr: string; code: number | null; home: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: dir, CAIRN_BASE_URL: `${base}/`, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code, home: dir }))
    child.stdin.end(options.stdin ?? '')
  })
}

const stage = { id: 's-1', name: 'exploring', category: 'active', color: '#6b7fa6', position: 1 }
const subject = {
  id: 'u-12',
  ref: 'LAB-12',
  number: 12,
  title: 'Evaluate pgvector for recall',
  body: 'We want semantic recall over knowledge.',
  stage,
  tags: [{ id: 't-1', name: 'search', color: '#8a8792', position: 0 }],
  project: { id: 'p-1', key: 'CAIRN', title: 'Cairn' },
  owner: { id: 'h-1', name: 'Cal' },
  conclusion: null,
  concluded_at: null,
  todos: { open: 2, done: 1 },
  position: 0,
  actor_type: 'agent',
  actor_id: 'claude-code',
  created_at: '2026-10-10T08:00:00.000Z',
  updated_at: '2026-10-10T09:00:00.000Z',
  archived_at: null,
}
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET')

describe('cairn subject list and ideas', () => {
  it('turns filters into the query, and prints one row per subject with its url last', async () => {
    const { seen, base } = serve(() => [subject])
    const url = await base()
    const out = await run(
      ['subject', 'list', 'pgvector', '--stage', 'exploring,done', '--tag', 'Search', '--mine', '--project', 'CAIRN', '--archived', 'only', '--limit', '20'],
      url,
    )
    expect(out.code).toBe(0)
    const query = new URL(`http://x${seen[0]!.path}`).searchParams
    expect(seen[0]!.path.startsWith('/api/v1/subjects?')).toBe(true)
    expect(Object.fromEntries(query)).toEqual({
      q: 'pgvector', stage: 'exploring,done', tag: 'search', owner: 'me', project: 'CAIRN', archived: 'only', limit: '20',
    })
    const lines = out.stdout.trim().split('\n')
    expect(lines[0]).toBe('#1')
    expect(lines[1]).toBe('ref\tstage\towner\ttodos\ttags\tproject\tanswered\ttitle\turl')
    expect(lines[2]).toBe(`LAB-12\texploring\tCal\t2/1\tsearch\tCAIRN\t\tEvaluate pgvector for recall\t${url}/lab/subjects/12`)
  })

  it('a bare --archived includes them, and a wrong value is refused before any request', async () => {
    const { seen, base } = serve(() => [])
    const url = await base()
    await run(['subject', 'list', '--archived'], url)
    expect(new URL(`http://x${seen[0]!.path}`).searchParams.get('archived')).toBe('include')
    const bad = await run(['subject', 'list', '--archived', 'sideways'], url)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--archived takes include')
    expect(seen).toHaveLength(1)
  })

  it('`ideas` is the planned category, and takes no stage or category of its own', async () => {
    const { seen, base } = serve(() => [])
    const url = await base()
    await run(['ideas', '--mine'], url)
    expect(Object.fromEntries(new URL(`http://x${seen[0]!.path}`).searchParams)).toEqual({ category: 'planned', owner: 'me' })
    const bad = await run(['ideas', '--stage', 'done'], url)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('planned stages')
  })

  it('--json is the server\'s list with each subject\'s url added', async () => {
    const { base } = serve(() => [subject])
    const url = await base()
    const out = JSON.parse((await run(['subject', 'list', '--json'], url)).stdout)
    expect(out[0]).toMatchObject({ ref: 'LAB-12', url: `${url}/lab/subjects/12` })
  })
})

describe('cairn subject show', () => {
  const routes = (seen: Seen) => {
    if (seen.path === '/api/v1/subjects/LAB-12') return { ...subject, conclusion: 'Use it behind a flag.', concluded_at: '2026-10-10T10:00:00.000Z' }
    if (seen.path === '/api/v1/subjects/LAB-12/notes') {
      return [
        { id: 'n-2', kind: 'finding', note: 'Recall went from 61% to 78%.', actor_type: 'agent', actor_id: 'claude-code', created_at: '2026-10-10T09:30:00.000Z' },
        { id: 'n-1', kind: 'attempt', note: 'Tried ivfflat, no change.', actor_type: 'agent', actor_id: 'codex', created_at: '2026-10-10T09:00:00.000Z' },
      ]
    }
    if (seen.path === '/api/v1/subjects/LAB-12/todos') {
      return [
        { id: 't-1', ref: 'LT-3', number: 3, title: 'Benchmark on prod data', status: 'doing', priority: 'high', type: 'spike', claimed_by: 'claude-code', assignee: null, handoff: null },
        { id: 't-2', ref: 'LT-2', number: 2, title: 'Pick an index', status: 'done', priority: 'medium', type: 'chore', claimed_by: null, assignee: null, handoff: null },
      ]
    }
    if (seen.path === '/api/v1/subjects/LAB-12/human-notes') return [{ id: 'h-1', body: 'Ask about cost.', author: { id: 'h-1', name: 'Cal' }, created_at: '2026-10-10T07:00:00.000Z', updated_at: '2026-10-10T07:00:00.000Z' }]
    if (seen.path === '/api/v1/subjects/LAB-12/attachments') return []
    return { fail: { error: `unexpected ${seen.path}`, code: 'not_found' }, status: 404 }
  }

  it('prints the conclusion, the open todos, the write-up and the log in one digest', async () => {
    const { base } = serve(routes)
    const out = await run(['subject', 'show', '12'], await base())
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('LAB-12  exploring  Evaluate pgvector for recall')
    expect(out.stdout).toContain('owner Cal · project CAIRN · tags search')
    expect(out.stdout).toContain('conclusion (')
    expect(out.stdout).toContain('Use it behind a flag.')
    expect(out.stdout).toContain('todos: 1 open / 1 closed')
    expect(out.stdout).toContain('LT-3  doing  held by claude-code  Benchmark on prod data')
    expect(out.stdout).not.toContain('Pick an index')
    expect(out.stdout).toContain('people\'s notes: 1 (cairn subject notes LAB-12)')
    expect(out.stdout).toContain('Recall went from 61% to 78%.')
  })

  it('--full lists the closed todos too', async () => {
    const { base } = serve(routes)
    const out = await run(['subject', 'show', 'lab-12', '--full'], await base())
    expect(out.stdout).toContain('Pick an index')
  })

  it('`cairn show LAB-12` follows the task route\'s 404 to the subject', async () => {
    const { seen, base } = serve((s) =>
      s.path.startsWith('/api/v1/tasks/')
        ? { status: 404, fail: { error: 'No task LAB-12.', code: 'not_found', subject: 'LAB-12', href: '/api/v1/subjects/LAB-12' } }
        : routes(s),
    )
    const out = await run(['show', 'LAB-12'], await base())
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('LAB-12  exploring')
    expect(seen[0]!.path).toBe('/api/v1/tasks/LAB-12?view=digest')
  })

  it('a task verb on a subject says it is one, rather than "not found"', async () => {
    const { base } = serve(() => ({
      status: 404,
      fail: { error: 'No task LAB-12.', code: 'not_found', subject: 'LAB-12', href: '/api/v1/subjects/LAB-12' },
    }))
    const out = await run(['note', 'LAB-12', 'a thought'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('LAB-12 is a subject, not a task: cairn subject show LAB-12')
  })

  it('a task ref is refused as a subject ref, saying what it is', async () => {
    const { seen, base } = serve(() => ({}))
    const out = await run(['subject', 'show', 'ACME-42'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('"ACME-42" is not a subject ref')
    expect(out.stderr).toContain('looks like a task')
    expect(seen).toHaveLength(0)
  })

  it('names what to do when the Lab is off', async () => {
    const { base } = serve(() => ({ status: 404, fail: { error: 'The Lab is not enabled on this instance.', code: 'lab_disabled' } }))
    const out = await run(['subject', 'list'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('The Lab is not enabled on this instance.')
    expect(out.stderr).toContain('cairn lab on')
  })
})

describe('cairn subject add, idea and edit', () => {
  it('add sends the whole subject, with none meaning nobody and no project', async () => {
    const { seen, base } = serve(() => subject)
    const out = await run(
      ['subject', 'add', 'Evaluate pgvector', '--stage', 'exploring', '--tag', 'search,infra', '--owner', 'none', '--project', 'none', '--body', '-'],
      await base(),
      { stdin: '## Why\n- recall\n' },
    )
    expect(out.code).toBe(0)
    expect(writes(seen)[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/subjects',
      body: { title: 'Evaluate pgvector', stage: 'exploring', tags: ['search', 'infra'], owner: null, project: null, body: '## Why\n- recall' },
    })
    expect(out.stderr).toContain('filed LAB-12')
  })

  it('idea files with no stage, so the server picks the first planned one', async () => {
    const { seen, base } = serve(() => ({ ...subject, stage: { ...stage, name: 'to explore', category: 'planned' } }))
    const out = await run(['idea', 'Try a local reranker', '--tag', 'search'], await base())
    expect(out.code).toBe(0)
    expect(writes(seen)[0]!.body).toEqual({ title: 'Try a local reranker', tags: ['search'] })
    expect(out.stderr).toContain('as an idea (to explore)')
  })

  it('idea refuses a stage or a conclusion, which belong to subject add', async () => {
    const { seen, base } = serve(() => subject)
    const out = await run(['idea', 'x', '--stage', 'done'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('cairn subject add')
    expect(seen).toHaveLength(0)
  })

  it('edit sends only what was passed, and reads --conclusion none as a clear', async () => {
    const { seen, base } = serve(() => subject)
    await run(['subject', 'edit', 'LAB-12', '--title', 'Evaluate pgvector 0.8', '--conclusion', 'none'], await base())
    expect(writes(seen)[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/subjects/LAB-12',
      body: { title: 'Evaluate pgvector 0.8', conclusion: null },
    })
  })

  it('edit with nothing to change says so instead of sending an empty patch', async () => {
    const { seen, base } = serve(() => subject)
    const out = await run(['subject', 'edit', 'LAB-12'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('nothing to change')
    expect(seen).toHaveLength(0)
  })
})

describe('cairn subject stage and note', () => {
  const needsConclusion = {
    status: 400,
    fail: { error: 'Moving into done needs a conclusion.', code: 'conclusion_required', stage: 'done', category: 'completed' },
  }

  it('a move that needs a conclusion is refused with the flag that supplies it', async () => {
    const { base } = serve(() => needsConclusion)
    const out = await run(['subject', 'stage', 'LAB-12', 'done'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('LAB-12 -> "done" needs a conclusion')
    expect(out.stderr).toContain('--conclusion "<what was concluded, and why>"')
  })

  it('does not repeat the flag when the server\'s own sentence already names it', async () => {
    const { base } = serve(() => ({
      status: 400,
      fail: {
        error: 'done is a completed stage: say what was learned. Send a conclusion with the move (cairn subject stage LAB-2 "done" --conclusion "<what we learned>").',
        code: 'conclusion_required',
      },
    }))
    const out = await run(['subject', 'stage', 'LAB-2', 'done'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('LAB-2 -> "done" needs a conclusion: done is a completed stage')
    expect(out.stderr).not.toContain('re-run with')
    expect(out.stderr.match(/--conclusion/g)).toHaveLength(1)
  })

  it('sends the conclusion with the move', async () => {
    const { seen, base } = serve(() => subject)
    await run(['subject', 'stage', 'LAB-12', 'done', '--conclusion', '-'], await base(), { stdin: 'Adopt it behind a flag.\n' })
    expect(writes(seen)[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/subjects/LAB-12',
      body: { stage: 'done', conclusion: 'Adopt it behind a flag.' },
    })
  })

  it('writes a log note of the kind asked for, and refuses the server\'s own `stage` kind', async () => {
    const { seen, base } = serve(() => ({ id: 'n-1', kind: 'finding', note: 'ok', actor_type: 'agent', actor_id: 'x', created_at: '2026-10-10T09:00:00.000Z' }))
    const url = await base()
    await run(['subject', 'note', 'LAB-12', 'Recall is up.', '--kind', 'finding'], url)
    expect(writes(seen)[0]).toMatchObject({ path: '/api/v1/subjects/LAB-12/notes', body: { note: 'Recall is up.', kind: 'finding' } })
    const bad = await run(['subject', 'note', 'LAB-12', 'x', '--kind', 'stage'], url)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('the server\'s')
    expect(writes(seen)).toHaveLength(1)
  })

  it('notes a dead end it recognises', async () => {
    const { base } = serve(() => ({ id: 'n-1', kind: 'note', note: 'x', actor_type: 'agent', actor_id: 'x', created_at: '2026-10-10T09:00:00.000Z' }))
    const out = await run(['subject', 'note', 'LAB-12', 'tried ivfflat, no change'], await base())
    expect(out.stderr).toContain('--kind attempt')
  })
})

describe('cairn subject tag, todo, archive and delete', () => {
  it('tag adds and removes against the current set', async () => {
    const { seen, base } = serve((s) => (s.method === 'GET' ? { ...subject, tags: [{ name: 'search' }, { name: 'infra' }] } : subject))
    await run(['subject', 'tag', 'LAB-12', '+Rerank', '-infra'], await base())
    expect(writes(seen)[0]).toMatchObject({ method: 'PATCH', body: { tags: ['search', 'rerank'] } })
  })

  it('todo files a task of the subject and claims it, as add does for a runtime', async () => {
    const { seen, base } = serve((s) =>
      s.path.endsWith('/claim')
        ? { ref: 'LT-4', status: 'doing', claimed_by: 'test' }
        : { ref: 'LT-4', number: 4, title: 'Benchmark', status: 'todo', subject: { ref: 'LAB-12', title: subject.title } },
    )
    const out = await run(['subject', 'todo', 'LAB-12', 'Benchmark', '--body', 'on prod data', '--priority', 'high'], await base())
    expect(out.code).toBe(0)
    expect(writes(seen).map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/v1/subjects/LAB-12/todos',
      'POST /api/v1/tasks/LT-4/claim',
    ])
    expect(writes(seen)[0]!.body).toEqual({ title: 'Benchmark', description: 'on prod data', priority: 'high' })
    expect(out.stdout).toContain('status\tdoing')
  })

  it('--no-start only files it', async () => {
    const { seen, base } = serve(() => ({ ref: 'LT-4', number: 4, title: 'Benchmark', status: 'todo' }))
    await run(['subject', 'todo', 'LAB-12', 'Benchmark', '--no-start'], await base())
    expect(writes(seen)).toHaveLength(1)
  })

  it('archive and restore send the one field', async () => {
    const { seen, base } = serve(() => subject)
    const url = await base()
    await run(['subject', 'archive', 'LAB-12'], url)
    await run(['subject', 'restore', 'LAB-12'], url)
    expect(writes(seen).map((s) => s.body)).toEqual([{ archived: true }, { archived: false }])
  })

  it('delete wants the ref typed twice, and never goes near the server without it', async () => {
    const { seen, base } = serve(() => ({}))
    const out = await run(['subject', 'delete', 'LAB-12'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('--confirm LAB-12')
    expect(out.stderr).toContain('cairn subject archive LAB-12')
    expect(seen).toHaveLength(0)
  })

  it('a delete refused for todos says detaching is the only way, and that nothing deletes a todo', async () => {
    const { seen, base } = serve(() => ({
      status: 409,
      fail: { error: 'LAB-12 has todos.', code: 'subject_has_todos', todos: 3, open: 2 },
    }))
    const url = await base()
    const refused = await run(['subject', 'delete', 'LAB-12', '--confirm', 'LAB-12'], url)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('has 3 todo(s) (2 open)')
    expect(refused.stderr).toContain('--detach-todos')
    expect(seen[0]!.path).toBe('/api/v1/subjects/LAB-12?confirm=LAB-12')
  })

  it('--detach-todos adds todos=detach and reports what was detached', async () => {
    const { seen, base } = serve(() => ({ deleted: true, ref: 'LAB-12', id: 'u', todos_detached: 3, files_removed: 1 }))
    const out = await run(['subject', 'delete', 'lab-12', '--confirm', 'lab-12', '--detach-todos'], await base())
    expect(out.code).toBe(0)
    expect(seen[0]!.path).toBe('/api/v1/subjects/LAB-12?confirm=LAB-12&todos=detach')
    expect(out.stderr).toContain('3 todo(s) detached, 1 file(s) removed')
  })

  it('mentions prints who names it', async () => {
    const { base } = serve(() => ({
      total: 1,
      items: [{ ref: 'CAIRN-9', title: 'Wire recall', status: 'doing', source: 'description', excerpt: 'see LAB-12', at: '2026-10-10T09:00:00.000Z' }],
    }))
    const out = await run(['subject', 'mentions', 'LAB-12'], await base())
    expect(out.stdout).toContain('CAIRN-9\tdoing\tdescription')
  })
})

describe('--subject on the task verbs', () => {
  it('add links the new task, and update takes none as an unlink', async () => {
    const { seen, base } = serve(() => ({ ref: 'ACME-1', number: 1, title: 'x', status: 'todo', results: [], tasks: [] }))
    const url = await base()
    await run(['add', 'Wire the relay', '--project', 'ACME', '--no-start', '--subject', 'lab-12'], url)
    await run(['update', 'ACME-1', '--subject', 'none'], url)
    await run(['update', 'ACME-1', '--subject', 'LAB-3'], url)
    const posts = writes(seen)
    expect(posts[0]!.body).toMatchObject({ title: 'Wire the relay', subject: 'LAB-12' })
    expect(posts[1]!.body).toEqual({ subject: null })
    expect(posts[2]!.body).toEqual({ subject: 'LAB-3' })
  })

  it('add refuses --subject none: there is nothing to unlink on a new task', async () => {
    const { seen, base } = serve(() => ({}))
    const out = await run(['add', 'x', '--project', 'ACME', '--subject', 'none'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('nothing to unlink')
    expect(writes(seen)).toHaveLength(0)
  })

  it('list --subject without a project is the subject\'s todos, across projects', async () => {
    const { seen, base } = serve(() => [
      { ref: 'LT-3', title: 'Benchmark', status: 'doing', priority: 'high', type: 'spike', claimed_by: 'claude-code', assignee: { name: 'Cal' }, handoff: { tracker: 'cairn', ref: 'KDP-4', status: 'doing' } },
    ])
    const url = await base()
    const out = await run(['list', '--subject', 'LAB-12', '--status', 'doing'], url)
    expect(out.code).toBe(0)
    expect(seen[0]!.path).toBe('/api/v1/subjects/LAB-12/todos?status=doing')
    const lines = out.stdout.trim().split('\n')
    expect(lines[1]).toBe('ref\tstatus\ttype\tpriority\tassignee\theld\thandoff\ttitle\turl')
    expect(lines[2]).toBe(`LT-3\tdoing\tspike\thigh\tCal\tclaude-code\tcairn:KDP-4 doing\tBenchmark\t${url}/projects/LT/tasks/3`)
  })

  it('list --subject with a project narrows that project\'s list and appends the columns it has', async () => {
    const { seen, base } = serve(() => ({
      tasks: [{ number: 5, title: 'Index it', status: 'todo', type: 'chore', priority: 'low', subject: { ref: 'LAB-12', title: 'x' }, handoff: null }],
    }))
    const out = await run(['list', '--project', 'CAIRN', '--subject', 'LAB-12'], await base())
    expect(seen[0]!.path).toBe('/api/v1/projects/CAIRN/tasks?subject=LAB-12')
    expect(out.stdout.trim().split('\n')[1]!.split('\t').slice(-2)).toEqual(['url', 'subject'])
  })

  it('check rows of kind subject carry the subject\'s page', async () => {
    const { base } = serve(() => ({
      results: [{ kind: 'subject', ref: 'LAB-12', title: 'Evaluate pgvector', status: 'done', type: 'subject', resolved: true, tokens: 40 }],
    }))
    const url = await base()
    const out = await run(['check', 'pgvector', '--kinds', 'subject'], url)
    expect(out.stdout.trim().split('\n').at(-1)!.split('\t').at(-1)).toBe(`${url}/lab/subjects/12`)
  })
})

describe('cairn lab', () => {
  it('shows the settings, and says how to switch it on when it is off', async () => {
    const { seen, base } = serve(() => ({ enabled: false, home_project: null, updated_at: null }))
    const out = await run(['lab'], await base())
    expect(seen[0]!.path).toBe('/api/v1/lab/settings')
    expect(out.stdout).toContain('enabled\tfalse')
    expect(out.stderr).toContain('cairn lab on')
  })

  it('on and off are a PUT, and an agent\'s refusal is explained', async () => {
    const forbidden = serve(() => ({ status: 403, fail: { error: 'Only a human administrator can change the Lab.', code: 'forbidden' } }))
    const out = await run(['lab', 'on'], await forbidden.base())
    expect(forbidden.seen[0]).toMatchObject({ method: 'PUT', path: '/api/v1/lab/settings', body: { enabled: true } })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('human administrator')
    expect(out.stderr).toContain('an agent key is refused')
  })

  it('says on stderr what the server warned about when switching on, and keeps it in the JSON', async () => {
    const { base } = serve(() => ({ enabled: true, home_project: null, warning: 'The LAB reservation could not be added.' }))
    const url = await base()
    const out = await run(['lab', 'on'], url)
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('enabled\ttrue')
    expect(out.stdout).not.toContain('warning')
    expect(out.stderr).toContain('warning: The LAB reservation could not be added.')
    expect(JSON.parse((await run(['lab', 'on', '--json'], url)).stdout).warning).toContain('reservation')
  })

  it('home sends the key, or null for default', async () => {
    const { seen, base } = serve(() => ({ enabled: true, home_project: { key: 'LT' } }))
    const url = await base()
    await run(['lab', 'home', 'LT'], url)
    await run(['lab', 'home', 'default'], url)
    expect(seen.map((s) => s.body)).toEqual([{ homeProject: 'LT' }, { homeProject: null }])
  })

  it('stages lists in board order and marks the ones that need a conclusion', async () => {
    const { base } = serve(() => [
      { id: 'b', name: 'done', category: 'completed', color: '#5f8a63', position: 2 },
      { id: 'a', name: 'to explore', category: 'planned', color: '#8a8792', position: 0 },
    ])
    const out = await run(['lab', 'stages'], await base())
    const rows = out.stdout.trim().split('\n').slice(2)
    expect(rows).toEqual(['to explore\tplanned\t#8a8792\t', 'done\tcompleted\t#5f8a63\trequired'])
  })

  it('stages add validates the category and colour before asking', async () => {
    const { seen, base } = serve(() => ({}))
    const url = await base()
    expect((await run(['lab', 'stages', 'add', 'parked', '--category', 'someday'], url)).stderr).toContain('--category must be one of')
    expect((await run(['lab', 'stages', 'add', 'parked', '--category', 'dropped', '--color', 'red'], url)).stderr).toContain('use #rrggbb')
    expect(seen).toHaveLength(0)
    await run(['lab', 'stages', 'add', 'parked', '--category', 'dropped', '--color', '#A0685F'], url)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/lab/stages', body: { name: 'parked', category: 'dropped', color: '#a0685f' } })
  })

  it('stages edit and remove resolve the name to its id', async () => {
    const { seen, base } = serve((s) =>
      s.method === 'GET' ? [{ id: 'id-1', name: 'Exploring', category: 'active', position: 1 }] : { id: 'id-1' },
    )
    const url = await base()
    await run(['lab', 'stages', 'edit', 'exploring', '--name', 'investigating', '--position', '2'], url)
    await run(['lab', 'stages', 'remove', 'EXPLORING'], url)
    expect(writes(seen).map((s) => `${s.method} ${s.path}`)).toEqual([
      'PATCH /api/v1/lab/stages/id-1',
      'DELETE /api/v1/lab/stages/id-1',
    ])
    expect(writes(seen)[0]!.body).toEqual({ name: 'investigating', position: 2 })
  })

  it('removing a stage that holds subjects says to move them first', async () => {
    const { base } = serve((s) =>
      s.method === 'GET'
        ? [{ id: 'id-1', name: 'exploring', category: 'active', position: 1 }]
        : { status: 409, fail: { error: 'In use.', code: 'stage_in_use', subjects: 4 } },
    )
    const out = await run(['lab', 'stages', 'remove', 'exploring'], await base())
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('holds 4 subject(s)')
    expect(out.stderr).toContain('cairn subject stage LAB-n')
  })

  it('order names every stage once, and says which are missing', async () => {
    const { seen, base } = serve((s) =>
      s.method === 'GET'
        ? [{ id: 'a', name: 'one', position: 0 }, { id: 'b', name: 'two', position: 1 }, { id: 'c', name: 'three', position: 2 }]
        : [],
    )
    const url = await base()
    const short = await run(['lab', 'stages', 'order', 'two,one'], url)
    expect(short.code).toBe(1)
    expect(short.stderr).toContain('missing: three')
    await run(['lab', 'stages', 'order', 'three,one,two'], url)
    expect(writes(seen)[0]).toMatchObject({ path: '/api/v1/lab/stages/reorder', body: { ids: ['c', 'a', 'b'] } })
  })

  it('tags add, edit and remove', async () => {
    const { seen, base } = serve((s) => (s.method === 'GET' ? [{ id: 'tag-1', name: 'search', color: '#8a8792' }] : { id: 'tag-1' }))
    const url = await base()
    await run(['lab', 'tags', 'add', 'Infra', '--color', '#112233'], url)
    await run(['lab', 'tags', 'edit', 'search', '--name', 'recall'], url)
    await run(['lab', 'tags', 'remove', 'search'], url)
    expect(writes(seen).map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/v1/lab/tags',
      'PATCH /api/v1/lab/tags/tag-1',
      'DELETE /api/v1/lab/tags/tag-1',
    ])
  })
})

describe('the briefing', () => {
  const context = {
    project: 'CAIRN',
    held: [],
    lab: {
      stages: [
        { id: 'a', name: 'to explore', category: 'planned', position: 0, count: 12 },
        { id: 'b', name: 'exploring', category: 'active', position: 1, count: 0 },
        { id: 'c', name: 'implementing', category: 'active', position: 5, count: 5 },
        { id: 'd', name: 'done', category: 'completed', position: 2, count: 30 },
      ],
      mine: [{ ...subject, todos: { open: 5, done: 0 }, stage: { ...stage, name: 'implementing' } }],
    },
  }

  it('renders stage counts and the caller\'s subjects, without the finished ones', async () => {
    const { base } = serve(() => context)
    const out = await run(['context', '--cwd', '/tmp'], await base())
    expect(out.stdout).toContain('Lab: 12 to explore · 5 implementing')
    expect(out.stdout).not.toContain('30 done')
    expect(out.stdout).toContain('LAB-12  implementing  Evaluate pgvector for recall -- 5 todos')
    // What an agent needs to know on a Lab instance, in the block it reads.
    expect(out.stdout).toContain('An idea is a subject (cairn idea "<title>")')
    expect(out.stdout).toContain('its todos are tasks (cairn subject todo LAB-n)')
    expect(out.stdout).toContain('closing it needs a conclusion')
    expect(out.stdout).toContain('Work that leaves this instance: cairn handoff <ref>')
  })

  it('says nothing about the Lab when the server sent no lab field, or an empty one', async () => {
    const off = await run(['context', '--cwd', '/tmp'], await serve(() => ({ project: 'CAIRN', held: [{ ref: 'A-1', status: 'doing', title: 'x' }] })).base())
    expect(off.stdout).not.toContain('Lab')
    const empty = await run(
      ['context', '--cwd', '/tmp'],
      await serve(() => ({ project: 'CAIRN', held: [{ ref: 'A-1', status: 'doing', title: 'x' }], lab: { stages: [{ name: 'to explore', category: 'planned', count: 0 }], mine: [] } })).base(),
    )
    expect(empty.stdout).not.toContain('Lab')
  })

  it('a Lab with something in it is a briefing on its own', async () => {
    const out = await run(['context', '--cwd', '/tmp'], await serve(() => ({ project: null, held: [], lab: context.lab })).base())
    expect(out.stdout).toContain('## Cairn [unfiled]')
    expect(out.stdout).toContain('Lab: 12 to explore')
  })

  it('--json is the response, untouched', async () => {
    const out = await run(['context', '--cwd', '/tmp', '--json'], await serve(() => context).base())
    expect(JSON.parse(out.stdout).lab.stages).toHaveLength(4)
  })
})

describe('help', () => {
  it('shows the Lab only where it is on, as the last briefing or `cairn lab` learned', async () => {
    const { base } = serve((s) => (s.path.startsWith('/api/v1/lab/settings') ? { enabled: true } : {}))
    const url = await base()
    const dir = await home()
    const before = await run(['--help'], url, { home: dir })
    expect(before.stdout).not.toContain('cairn subject add')
    expect(before.stdout).not.toContain('@@')
    expect(before.stdout).toContain('cairn handoff <ref>')

    await run(['lab'], url, { home: dir })
    const after = await run(['--help'], url, { home: dir })
    expect(after.stdout).toContain('the lab — exploring and proving ideas')
    expect(after.stdout).toContain('cairn subject add')
    expect(after.stdout).not.toContain('@@')
  })

  it('carries the essentials: an idea is a subject, a conclusion closes it, todos are tasks, hand-off leaves', async () => {
    const { base } = serve(() => ({ enabled: true }))
    const url = await base()
    const dir = await home()
    await run(['lab'], url, { home: dir })
    const help = (await run(['--help'], url, { home: dir })).stdout
    const lab = help.slice(help.indexOf('the lab — '))
    expect(lab).toContain('an idea is a subject (LAB-n), not a task')
    expect(lab).toContain('its todos are ordinary tasks (--subject)')
    expect(lab).toContain('needs a conclusion')
    expect(lab).toContain('work that leaves')
    expect(lab).toContain('`cairn handoff`')
  })

  it('a stale or unreadable lab.json is only a hint: no command fails on it', async () => {
    const { base } = serve(() => ({ project: null, held: [{ ref: 'A-1', status: 'doing', title: 'x' }] }))
    const url = await base()
    const dir = await home()
    await mkdir(join(dir, '.cairn'), { recursive: true })
    for (const content of ['not json', '{"enabled":"yes"}', '[]', '']) {
      await writeFile(join(dir, '.cairn', 'lab.json'), content)
      const out = await run(['context', '--cwd', '/tmp'], url, { home: dir })
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('A-1')
      const help = await run(['--help'], url, { home: dir })
      expect(help.code).toBe(0)
      expect(help.stdout).not.toContain('@@')
    }
  })

  it('goes back to hiding it when the briefing no longer has a lab', async () => {
    const { base } = serve((s) => (s.path.startsWith('/api/v1/context') ? { project: null, held: [] } : { enabled: true }))
    const url = await base()
    const dir = await home()
    await run(['lab'], url, { home: dir })
    expect((await run(['--help'], url, { home: dir })).stdout).toContain('cairn subject add')
    await run(['context', '--cwd', '/tmp'], url, { home: dir })
    expect((await run(['--help'], url, { home: dir })).stdout).not.toContain('cairn subject add')
  })

  it('reads the instance named with --instance on a machine with several', async () => {
    const dir = await home()
    await mkdir(join(dir, '.cairn', 'instances', 'work'), { recursive: true })
    await writeFile(join(dir, '.cairn', 'instances', 'work', 'lab.json'), JSON.stringify({ enabled: true }))
    await writeFile(
      join(dir, '.cairn', 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: { personal: { url: 'https://p.example.test' }, work: { url: 'https://w.example.test' } },
        unclassified: { mode: 'ask' },
      }),
    )
    const base = 'http://127.0.0.1:1'
    expect((await run(['--help', '--instance', 'work'], base, { home: dir })).stdout).toContain('cairn subject add')
    expect((await run(['--help', '--instance', 'personal'], base, { home: dir })).stdout).not.toContain('cairn subject add')
  })
})

describe('the flags the Lab verbs read', () => {
  const source = readFileSync(join(process.cwd(), 'cli/cairn.mjs'), 'utf8')
  const known = new Set(
    [...(/const KNOWN_FLAGS = new Set\(\[([\s\S]*?)\]\)/.exec(source)![1]!).matchAll(/'([^']+)'/g)].map((m) => m[1]!),
  )

  it('every flag in the Lab\'s help is one the parser knows (it exits 2 on the rest)', () => {
    const labHelp = /const LAB_HELP = `([\s\S]*?)\n`$/m.exec(source)![1]!
    const named = [...new Set([...labHelp.matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[1]!))]
    expect(named.length).toBeGreaterThan(10)
    expect(named.filter((flag) => !known.has(flag))).toEqual([])
  })

  it('and so is every flag the hand-off help names', () => {
    const handoff = /hand-off\n([\s\S]*?)@@lab@@/.exec(source)![1]!
    const named = [...new Set([...handoff.matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[1]!))]
    expect(named).toEqual(expect.arrayContaining(['to', 'link', 'url', 'undo', 'all-instances', 'project']))
    expect(named.filter((flag) => !known.has(flag))).toEqual([])
  })
})
