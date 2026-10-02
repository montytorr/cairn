import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `--related` and `cairn link` (CAIRN-350): half the store linked to nothing,
 * because linking meant spelling a slug inside a body and acting on `learn`'s
 * own same-subject nudge meant restating the whole entry.
 *
 * cli/cairn.mjs is a standalone copy in ~/.local/bin and cannot import a
 * module, so the pure half — the Related-line merge — is lifted out of it from
 * between its markers and evaluated alone. The rest is asserted on the wire.
 */
type Merged = { body: string; added: string[]; already: string[]; invalid: string[]; selfLinked: boolean }
type Helpers = { withRelated: (body: string, slugs: string[], self?: string | null) => Merged }

const helpers = (): Helpers => {
  const source = readFileSync(join(process.cwd(), 'cli/cairn.mjs'), 'utf8')
  const block = /\/\/ <related-links>\n([\s\S]*?)\/\/ <\/related-links>/.exec(source)
  if (!block) throw new Error('related-links block not found in cli/cairn.mjs')
  return new Function(`${block[1]}\nreturn { withRelated }`)() as Helpers
}

const { withRelated } = helpers()

describe('withRelated', () => {
  it('gives an empty body nothing but the Related line', () => {
    expect(withRelated('', ['a-fact', 'b-fact']).body).toBe('Related: [[a-fact]], [[b-fact]]')
  })

  it('appends a Related line after a blank line, trimming trailing whitespace', () => {
    const merged = withRelated('Pools are per tenant.\n\n', ['a-fact'])
    expect(merged.body).toBe('Pools are per tenant.\n\nRelated: [[a-fact]]')
    expect(merged.added).toEqual(['a-fact'])
  })

  it('grows a trailing Related line rather than adding a second one', () => {
    const merged = withRelated('Text.\n\nRelated: [[a-fact]]\n', ['b-fact'])
    expect(merged.body).toBe('Text.\n\nRelated: [[a-fact]], [[b-fact]]')
  })

  it('keeps a trailing full stop out of the list it grows', () => {
    expect(withRelated('Text.\n\nRelated: [[a-fact]].', ['b-fact']).body).toBe('Text.\n\nRelated: [[a-fact]], [[b-fact]]')
  })

  it('fills an empty trailing Related line without a leading comma', () => {
    expect(withRelated('Text.\n\nRelated:', ['b-fact']).body).toBe('Text.\n\nRelated: [[b-fact]]')
  })

  it('adds a new trailing line when the Related line is not last, without repeating what it holds', () => {
    const body = 'Text.\n\nRelated: [[a-fact]]\n\n## Later\n\nMore.'
    const merged = withRelated(body, ['a-fact', 'b-fact'])
    expect(merged.body).toBe(`${body}\n\nRelated: [[b-fact]]`)
    expect(merged.added).toEqual(['b-fact'])
    expect(merged.already).toEqual(['a-fact'])
  })

  it('normalises case and underscores the way the server resolves references', () => {
    const merged = withRelated('Text.', ['Supavisor_Pools', 'supavisor-pools', '[[Other_Fact]]'])
    expect(merged.body).toBe('Text.\n\nRelated: [[supavisor-pools]], [[other-fact]]')
  })

  it('does not add a slug the body already links anywhere, in any spelling', () => {
    const merged = withRelated('See [[A_Fact]] for the history.', ['a-fact'])
    expect(merged.added).toEqual([])
    expect(merged.already).toEqual(['a-fact'])
    expect(merged.body).toBe('See [[A_Fact]] for the history.')
  })

  it('does not count a [[slug]] inside code as a link', () => {
    const merged = withRelated('Write `[[a-fact]]` to link.\n\n```\n[[b-fact]]\n```', ['a-fact', 'b-fact'])
    expect(merged.added).toEqual(['a-fact', 'b-fact'])
  })

  it('refuses a self-link, in any spelling, and changes nothing', () => {
    const merged = withRelated('Text.', ['other', 'My_Fact'], 'my-fact')
    expect(merged.selfLinked).toBe(true)
    expect(merged.added).toEqual([])
    expect(merged.body).toBe('Text.')
  })

  it('reports what is not a slug instead of writing it', () => {
    const merged = withRelated('Text.', ['two words', 'ok-slug'])
    expect(merged.invalid).toEqual(['two words'])
    expect(merged.body).toBe('Text.')
  })
})

type Seen = { method: string; url: string; body?: Record<string, unknown>; headers: Record<string, unknown> }

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A store holding one entry, answering a write with the given same-subject list. */
const serve = (seen: Seen[], stored: { slug: string; body: string }, similar: unknown[] = []) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        const data =
          req.method === 'GET'
            ? stored
            : req.method === 'POST'
              ? { slug: (entry.body?.slug as string) ?? 'new-fact', similar }
              : { slug: stored.slug, body: entry.body?.body }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-related-'))
  directories.push(home)
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key', CAIRN_SWEEP: '' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr, stdout }))
  })
}

describe('learn --related', () => {
  it('sends the body with a Related line the server then checks', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'x', body: '' })
    const { code, stderr } = await run(
      ['learn', 'Pools are per tenant', '--body', 'It is so.', '--global', '--related', 'a-fact,B_Fact'],
      base,
    )

    expect(code, stderr).toBe(0)
    expect(stderr).not.toContain('does not take')
    expect(seen.find((s) => s.method === 'POST')?.body?.body).toBe('It is so.\n\nRelated: [[a-fact]], [[b-fact]]')
  })

  it('refuses a related slug that is the entry itself, before writing', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'x', body: '' })
    const { code, stderr } = await run(
      ['learn', 'A fact', '--body', 'It is so.', '--global', '--slug', 'a-fact', '--related', 'a-fact'],
      base,
    )

    expect(code).not.toBe(0)
    expect(stderr).toContain('cannot be related to itself')
    expect(seen.filter((s) => s.method === 'POST')).toEqual([])
  })

  it('knows the slug a title will get, when no --slug is given', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'x', body: '' })
    const { code, stderr } = await run(['learn', 'A fact', '--body', 'It is so.', '--global', '--related', 'a-fact'], base)

    expect(code).not.toBe(0)
    expect(stderr).toContain('cannot be related to itself')
  })

  it('turns the same-subject nudge into a command, leaving out what it already links', async () => {
    const seen: Seen[] = []
    const similar = [
      { slug: 'old-one', title: 'Old', scope: 'global' },
      { slug: 'old-two', title: 'Two', scope: 'global' },
      { slug: 'old-three', title: 'Three', scope: 'global' },
    ]
    const base = await serve(seen, { slug: 'x', body: '' }, similar)
    const { stderr } = await run(
      ['learn', 'A fact', '--body', 'It is so.', '--global', '--slug', 'new-fact', '--related', 'old-two'],
      base,
    )

    expect(stderr).toContain('cairn link new-fact old-one old-three')
    expect(stderr).toContain('cairn unlearn <slug> --superseded-by new-fact')
  })
})

describe('cairn link', () => {
  it('grows the stored body and PATCHes it with a default reason', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'Text.\n\nRelated: [[b-fact]]' })
    const { code } = await run(['link', 'a-fact', 'c-fact', 'D_Fact'], base)

    expect(code).toBe(0)
    const read = seen.find((s) => s.method === 'GET')
    // Reading an entry to extend it is not anybody recalling it.
    expect(read?.headers['x-cairn-read']).toBe('sweep')
    const patch = seen.find((s) => s.method === 'PATCH')
    expect(patch?.url).toBe('/api/v1/knowledge/a-fact')
    expect(patch?.body).toEqual({
      body: 'Text.\n\nRelated: [[b-fact]], [[c-fact]], [[d-fact]]',
      reason: 'linked to c-fact, d-fact',
    })
  })

  it('keeps a reason it is given', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'Text.' })
    await run(['link', 'a-fact', 'b-fact', '--reason', 'same pooler'], base)

    expect(seen.find((s) => s.method === 'PATCH')?.body?.reason).toBe('same pooler')
  })

  it('writes nothing, and exits 0, when everything named is already linked', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'See [[b-fact]].' })
    const { code, stdout, stderr } = await run(['link', 'a-fact', 'b_fact', '--reason', 'r'], base)

    expect(code).toBe(0)
    expect(stdout).toContain('nothing to change')
    expect(stderr).not.toContain('does not take')
    expect(seen.filter((s) => s.method === 'PATCH')).toEqual([])
  })

  it('refuses to link an entry to itself', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'Text.' })
    const { code, stderr } = await run(['link', 'a-fact', 'A_Fact'], base)

    expect(code).not.toBe(0)
    expect(stderr).toContain('cannot be related to itself')
    expect(seen.filter((s) => s.method === 'PATCH')).toEqual([])
  })
})

describe('relearn --related', () => {
  it('extends the stored body when no --body is given', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'Text.' })
    const { code } = await run(['relearn', 'a-fact', '--related', 'b-fact'], base)

    expect(code).toBe(0)
    expect(seen.find((s) => s.method === 'PATCH')?.body).toEqual({
      body: 'Text.\n\nRelated: [[b-fact]]',
      reason: 'linked to b-fact',
    })
  })

  it('extends the body it is given, without reading the stored one', async () => {
    const seen: Seen[] = []
    const base = await serve(seen, { slug: 'a-fact', body: 'Old.' })
    await run(['relearn', 'a-fact', '--body', 'New.', '--related', 'b-fact'], base)

    expect(seen.filter((s) => s.method === 'GET')).toEqual([])
    expect(seen.find((s) => s.method === 'PATCH')?.body?.body).toBe('New.\n\nRelated: [[b-fact]]')
  })
})
