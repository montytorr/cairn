import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Croft-to-Cairn importer (CAIRN-369) against real databases: a Croft
 * database built from Croft's own schema plus the fixture, and a Cairn database
 * built from this repo's migrations, the Lab's included. Each test imports into
 * a fresh copy of the target, so none of them sees another's rows.
 *
 * Needs CREATE DATABASE on DATABASE_URL's server (CI's user is the owner of the
 * server; a developer's local user usually is too). It never touches the
 * database DATABASE_URL names.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

type Row = Record<string, unknown>
type Report = {
  verdict: string
  errors: string[]
  warnings: string[]
  verification: { name: string; ok: boolean; detail: string }[] | null
  counts: Record<string, { source: number; insert?: number }> | null
  mode: string
  files: { count: number } | null
  rewrites: {
    applied: boolean
    totals: { rewritten: number; left: number; unknown: number }
    sample: unknown[]
  } | null
}
type Mapping = {
  applied: boolean
  subjects: Record<string, string>
  todos: Record<string, string>
  external_refs: Record<string, string>
}
type Result = { report: Report; text: string; mapping: Mapping | null; exitCode: number }
type Store = {
  describe: string
  read: (path: string) => Promise<Buffer>
  write: (path: string, bytes: Buffer) => Promise<void>
  remove: (path: string) => Promise<void>
}
type ImportInput = {
  croftUrl: string
  targetUrl: string
  apply?: boolean
  options?: Record<string, unknown>
  stores?: { source: Store | null; target: Store | null } | null
  mappingFile?: string | null
}
type Fixture = Record<string, Row[]> & { counter: number }

const load = <T>(path: string) => import(/* @vite-ignore */ join(process.cwd(), path)) as Promise<T>
const { importCroft } = await load<{ importCroft: (input: ImportInput) => Promise<Result> }>('scripts/import-croft.mjs')
const { migrate } = await load<{ migrate: (url: string, o: { dir: string; log: () => void }) => Promise<number> }>(
  'scripts/migrate.mjs',
)
const { diskStore } = await load<{ diskStore: (dir: string) => Store }>('scripts/import-croft/files.mjs')
const { readCroft, rawTypes } = await load<{
  readCroft: (client: pg.Client) => Promise<Fixture & { problems: string[] }>
  rawTypes: pg.ClientConfig['types']
}>('scripts/import-croft/read.mjs')
const { croftFixture, seedCroft, CAL, CAL_EMAIL } = await load<{
  croftFixture: (o?: { attachments?: boolean }) => { fixture: Fixture; files: Map<string, Buffer> }
  seedCroft: (client: pg.Client, fixture: Fixture) => Promise<void>
  CAL: string
  CAL_EMAIL: string
}>('tests/fixtures/croft/fixture.mjs')

const MIGRATIONS = join(process.cwd(), 'migrations')

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const names = {
  targetTemplate: `ci_target_t_${suffix}`,
  preLabTemplate: `ci_prelab_t_${suffix}`,
  croftTemplate: `ci_croft_t_${suffix}`,
  croftFiles: `ci_croftf_t_${suffix}`,
}
const created: string[] = []

const urlFor = (db: string) => {
  const u = new URL(databaseUrl)
  u.pathname = `/${db}`
  return u.toString()
}

const admin = () => new pg.Client({ connectionString: urlFor('postgres') })

const sql = async <T extends Row = Row>(db: string, text: string, params: unknown[] = []): Promise<T[]> => {
  const client = new pg.Client({ connectionString: urlFor(db), types: rawTypes, options: '-c timezone=UTC' })
  await client.connect()
  try {
    return (await client.query(text, params)).rows as T[]
  } finally {
    await client.end()
  }
}

/** Runs one statement and undoes it, for a test that probes a database it must leave as it found it. */
const probe = async <T extends Row = Row>(db: string, text: string, params: unknown[] = []): Promise<T[]> => {
  const client = new pg.Client({ connectionString: urlFor(db), types: rawTypes, options: '-c timezone=UTC' })
  await client.connect()
  try {
    await client.query('begin')
    try {
      return (await client.query(text, params)).rows as T[]
    } finally {
      await client.query('rollback')
    }
  } finally {
    await client.end()
  }
}

const createDb = async (name: string, template?: string) => {
  const client = admin()
  await client.connect()
  try {
    await client.query(`create database "${name}"${template ? ` template "${template}"` : ''}`)
    created.push(name)
  } finally {
    await client.end()
  }
}

const freshDb = async (prefix: string, template: string) => {
  const name = `${prefix}_${suffix}_${randomUUID().slice(0, 8)}`
  await createDb(name, template)
  return name
}

const croftSchema = await readFile(join(process.cwd(), 'tests/fixtures/croft/schema.sql'), 'utf8')

const scratch: string[] = []
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'croft-import-it-'))
  scratch.push(dir)
  return dir
}

const run = (target: string, croft: string, extra: Partial<ImportInput> = {}): Promise<Result> =>
  importCroft({ croftUrl: urlFor(croft), targetUrl: urlFor(target), ...extra })

const count = async (db: string, table: string) =>
  Number((await sql(db, `select count(*)::int as n from ${table}`))[0]?.n)

const EMPTY_TARGET_TABLES = [
  'subjects',
  'subject_notes',
  'subject_human_notes',
  'subject_attachments',
  'subject_tags',
  'lab_tags',
  'tasks',
  'task_notes',
  'task_comments',
  'task_attachments',
  'task_activity_events',
  'app_users',
  'projects',
]
const untouched = async (db: string) => {
  for (const table of EMPTY_TARGET_TABLES) expect(await count(db, table), table).toBe(0)
  const [settings] = await sql(db, 'select enabled, home_project_id from lab_settings')
  expect(settings).toMatchObject({ enabled: false, home_project_id: null })
  const [counter] = await sql(db, 'select last_number from subject_number_counter')
  expect(counter?.last_number).toBe(0)
}

let fixture: Fixture

beforeAll(async () => {
  // A Croft database: its own schema, then the fixture.
  await createDb(names.croftTemplate)
  const croft = new pg.Client({ connectionString: urlFor(names.croftTemplate) })
  await croft.connect()
  await croft.query(croftSchema)
  fixture = croftFixture().fixture
  await seedCroft(croft, fixture)
  await croft.end()

  // Cairn, without the Lab, and with it.
  const preLab = await tempDir()
  for (const f of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql') && f < '071')) {
    await writeFile(join(preLab, f), await readFile(join(MIGRATIONS, f)))
  }
  await createDb(names.preLabTemplate)
  await migrate(urlFor(names.preLabTemplate), { dir: preLab, log: () => {} })
  await createDb(names.targetTemplate)
  await migrate(urlFor(names.targetTemplate), { dir: MIGRATIONS, log: () => {} })
}, 120_000)

afterAll(async () => {
  const client = admin()
  await client.connect()
  for (const name of created) await client.query(`drop database if exists "${name}" with (force)`)
  await client.end()
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })))
})

describe('the Croft reader', () => {
  it('reads back what the fixture holds, timestamps to the microsecond', async () => {
    const client = new pg.Client({ connectionString: urlFor(names.croftTemplate), types: rawTypes, options: '-c timezone=UTC' })
    await client.connect()
    const snapshot = await readCroft(client)
    await client.end()
    expect(snapshot.problems).toEqual([])
    const withoutDerived = (row: Row) => {
      const { comments_text: _derived, ...rest } = row
      void _derived
      return rest
    }
    for (const key of ['users', 'stages', 'tags', 'labProjects', 'subjects', 'subjectNotes', 'subjectHumanNotes', 'tasks', 'taskNotes', 'taskComments', 'taskEvents']) {
      const read = new Map((snapshot[key] ?? []).map((r) => [String(r.id), r]))
      expect(read.size, key).toBe((fixture[key] ?? []).length)
      for (const want of fixture[key] ?? []) {
        expect(read.get(String(want.id)), `${key} ${String(want.id)}`).toMatchObject(withoutDerived(want))
      }
    }
    expect(snapshot.counter).toBe(20)
  })

  it('names a database that is not a Croft database', async () => {
    const empty = await freshDb('ci_empty', 'template0')
    const client = new pg.Client({ connectionString: urlFor(empty), types: rawTypes })
    await client.connect()
    const snapshot = await readCroft(client)
    await client.end()
    expect(snapshot.problems.join('\n')).toMatch(/no table app_users/)
  })
})

describe('a dry run', () => {
  it('runs the whole write path, reports, and leaves the target as it was', async () => {
    const target = await freshDb('ci_dry', names.targetTemplate)
    const dir = await tempDir()
    const mappingFile = join(dir, 'mapping.json')
    const result = await run(target, names.croftTemplate, { mappingFile })

    expect(result.exitCode).toBe(0)
    expect(result.report).toMatchObject({ mode: 'dry-run', verdict: 'ready', errors: [] })
    expect(result.report.verification?.every((v) => v.ok)).toBe(true)
    expect(result.report.counts?.subjects).toMatchObject({ source: 19, insert: 19 })
    expect(result.report.counts?.tasks).toMatchObject({ source: 63, insert: 63 })
    expect(result.text).toContain('DRY RUN')
    await untouched(target)

    // The mapping is there to read, marked as not applied.
    const mapping = JSON.parse(await readFile(mappingFile, 'utf8')) as Mapping
    expect(mapping.applied).toBe(false)
    expect(Object.keys(mapping.subjects)).toHaveLength(19)
  })

  it('is the default: a missing --apply writes nothing even when it would succeed', async () => {
    const target = await freshDb('ci_dry2', names.targetTemplate)
    const result = await run(target, names.croftTemplate, { apply: false })
    expect(result.report.verdict).toBe('ready')
    expect(await count(target, 'subjects')).toBe(0)
  })
})

describe('--apply', () => {
  let target: string
  let result: Result
  let mapping: Mapping

  beforeAll(async () => {
    target = await freshDb('ci_apply', names.targetTemplate)
    const dir = await tempDir()
    const mappingFile = join(dir, 'mapping.json')
    result = await run(target, names.croftTemplate, { apply: true, mappingFile })
    mapping = JSON.parse(await readFile(mappingFile, 'utf8')) as Mapping
  })

  it('succeeds and says what it checked', () => {
    expect(result.exitCode).toBe(0)
    expect(result.report).toMatchObject({ mode: 'apply', verdict: 'applied', errors: [] })
    expect(result.report.verification?.every((v) => v.ok)).toBe(true)
  })

  it('keeps subject numbers, and the counter ends past the highest, deleted ones included', async () => {
    const numbers = (await sql(target, 'select number from subjects order by number')).map((r) => r.number)
    expect(numbers).toEqual([...Array(20).keys()].map((i) => i + 1).filter((n) => n !== 15))
    const [counter] = await sql(target, 'select last_number from subject_number_counter')
    expect(counter?.last_number).toBe(20)
    // The next subject, made the ordinary way, is LAB-21 and never LAB-15.
    const [stage] = await sql(target, 'select id from lab_stages limit 1')
    const [next] = await probe(
      target,
      `insert into subjects (title, stage_id, actor_type, actor_id) values ('next', $1, 'human', 'test') returning number`,
      [stage?.id],
    )
    expect(next?.number).toBe(21)
  })

  it('keeps every subject field, author and time', async () => {
    const rows = await sql(target, 'select * from subjects order by number')
    expect(rows).toHaveLength(19)
    for (const want of fixture.subjects ?? []) {
      const got = rows.find((r) => r.number === want.number)
      expect(got, `S-${String(want.number)}`).toMatchObject({
        id: want.id,
        title: want.title,
        body: want.body,
        conclusion: want.conclusion,
        position: want.position,
        actor_type: want.actor_type,
        actor_id: want.actor_id,
        owner_user_id: want.owner_user_id,
        project_id: want.project_id,
      })
      for (const col of ['created_at', 'updated_at', 'archived_at']) {
        expect(got?.[col] ?? null, `S-${String(want.number)} ${col}`).toBe(want[col] ?? null)
      }
    }
    // Archived subjects are in, and stay archived.
    expect(rows.filter((r) => r.archived_at !== null)).toHaveLength(2)
  })

  it('reconciles the seeded stages by name instead of duplicating them', async () => {
    expect(await count(target, 'lab_stages')).toBe(9)
    const used = await sql(
      target,
      `select s.name, count(*)::int as n from subjects x join lab_stages s on s.id = x.stage_id group by s.name order by s.name`,
    )
    expect(Object.fromEntries(used.map((r) => [r.name, r.n]))).toEqual({
      'to explore': 12,
      implementing: 5,
      'internal testing': 2,
    })
  })

  it('creates the tags, the projects with their hand-off, and the home project', async () => {
    expect((await sql(target, 'select name from lab_tags order by position')).map((r) => r.name)).toEqual([
      'search',
      'infra',
      'ai',
      'growth',
    ])
    expect(await count(target, 'subject_tags')).toBe(fixture.subjectTags?.length)
    const projects = await sql(target, `select key, handoff_tracker, handoff_target, status, task_counter, owner_user_id from projects order by key`)
    expect(projects.map((p) => p.key)).toEqual(['CROFT', 'LT', 'TRIG'])
    expect(projects.find((p) => p.key === 'TRIG')).toMatchObject({ handoff_tracker: 'cairn', handoff_target: 'TRIG', task_counter: 18 })
    expect(projects.find((p) => p.key === 'CROFT')).toMatchObject({ handoff_tracker: 'cairn', handoff_target: 'CROFT', task_counter: 4 })
    expect(projects.find((p) => p.key === 'LT')).toMatchObject({ handoff_tracker: null, task_counter: 41 })
    expect(projects.every((p) => p.owner_user_id === CAL)).toBe(true)

    const [settings] = await sql(target, `select s.enabled, p.key from lab_settings s join projects p on p.id = s.home_project_id`)
    expect(settings).toMatchObject({ enabled: true, key: 'LT' })
  })

  it('copies users with their password hashes and roles, but no keys', async () => {
    const users = await sql(target, 'select email, encrypted_password, role, created_at from app_users order by email')
    expect(users.map((u) => u.email)).toEqual(['cal@example.test', 'mael@example.test'])
    for (const u of users) {
      const want = fixture.users?.find((f) => f.email === u.email)
      expect(u).toMatchObject({ encrypted_password: want?.encrypted_password, role: want?.role, created_at: want?.created_at })
    }
    const profiles = await sql(target, 'select id, display_name from user_profiles order by display_name')
    expect(profiles.map((p) => p.display_name)).toEqual(['Cal', 'Mael'])
    expect(await count(target, 'api_keys')).toBe(0)
  })

  it('keeps the log: kinds, authors and times, with visibility becoming note', async () => {
    const notes = await sql(target, 'select * from subject_notes')
    expect(notes).toHaveLength(fixture.subjectNotes?.length ?? -1)
    expect(notes.some((n) => n.kind === 'visibility')).toBe(false)
    for (const want of fixture.subjectNotes ?? []) {
      const got = notes.find((n) => n.id === want.id)
      expect(got).toMatchObject({
        subject_id: want.subject_id,
        note: want.note,
        actor_type: want.actor_type,
        actor_id: want.actor_id,
        user_id: want.user_id,
        content_hash: want.content_hash,
        created_at: want.created_at,
        kind: want.kind === 'visibility' ? 'note' : want.kind,
      })
    }
    const kinds = await sql(target, 'select kind, count(*)::int as n from subject_notes group by kind')
    expect(kinds.map((k) => k.kind).sort()).toEqual(['attempt', 'decision', 'finding', 'handoff', 'note', 'stage'])
  })

  it('keeps the two human notes with their authors', async () => {
    const notes = await sql(target, 'select body, user_id, actor_id, created_at, updated_at from subject_human_notes order by created_at')
    expect(notes).toHaveLength(2)
    for (const n of notes) {
      const want = fixture.subjectHumanNotes?.find((f) => f.body === n.body)
      expect(n).toMatchObject({ user_id: want?.user_id, actor_id: want?.actor_id, created_at: want?.created_at, updated_at: want?.updated_at })
    }
  })

  it('files the todos by subject project, keeps their fields and clears claims', async () => {
    const tasks = await sql(
      target,
      `select t.*, p.key as project_key, s.number as subject_number
         from tasks t join projects p on p.id = t.project_id left join subjects s on s.id = t.subject_id`,
    )
    expect(tasks).toHaveLength(63)
    expect(tasks.filter((t) => t.project_key === 'TRIG')).toHaveLength(18)
    expect(tasks.filter((t) => t.project_key === 'CROFT')).toHaveLength(4)
    expect(tasks.filter((t) => t.project_key === 'LT')).toHaveLength(41)
    expect(tasks.filter((t) => t.subject_id === null)).toHaveLength(13)
    expect(tasks.every((t) => t.claimed_by === null && t.claimed_at === null && t.heartbeat_at === null)).toBe(true)

    for (const want of fixture.tasks ?? []) {
      const got = tasks.find((t) => t.id === want.id)
      const ref = `T-${String(want.number)}`
      expect(got, ref).toMatchObject({
        title: want.title,
        description: want.description,
        type: want.type,
        priority: want.priority,
        actor_type: want.actor_type,
        actor_id: want.actor_id,
        assignee_user_id: want.assignee_user_id,
        resolution: want.resolution,
        resolution_kind: want.resolution_kind,
        resolved_by: want.resolved_by,
        subject_id: want.subject_id,
        parent_id: want.parent_id,
        duplicate_of: want.duplicate_of,
        external_ref: want.number === 60 ? 'croft:croft.montytorr.com/T-60' : `croft:croft.montytorr.com/${ref}`,
      })
      for (const col of ['created_at', 'updated_at', 'resolved_at']) {
        expect(got?.[col] ?? null, `${ref} ${col}`).toBe(want[col] ?? null)
      }
      // Doing with a claim goes back to todo, unless the tracker owns the status.
      if (want.number === 50) expect(got?.status).toBe('todo')
      else expect(got?.status, ref).toBe(want.status)
    }
    // The tasks of one project are numbered 1..n with no gap.
    for (const key of ['TRIG', 'CROFT', 'LT']) {
      const numbers = tasks.filter((t) => t.project_key === key).map((t) => Number(t.number)).sort((a, b) => a - b)
      expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    }
  })

  it('carries hand-offs, and gives each cairn link the absolute URL in the personal Cairn', async () => {
    const handed = await sql(
      target,
      `select handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at from tasks where handoff_tracker is not null`,
    )
    expect(handed).toHaveLength(41)
    for (const h of handed) {
      expect(h.handoff_tracker).toBe('cairn')
      const [key, n] = String(h.handoff_ref).split('-')
      expect(h.handoff_url).toBe(`https://tasks.montytorr.com/projects/${key}/tasks/${n}`)
    }
    const want = new Map((fixture.tasks ?? []).filter((t) => t.handoff_ref).map((t) => [t.handoff_ref, t]))
    for (const h of handed) {
      expect(h.handoff_status ?? null).toBe(want.get(h.handoff_ref)?.handoff_status ?? null)
      expect(h.handoff_synced_at).toBe(want.get(h.handoff_ref)?.handoff_synced_at)
    }
  })

  it('carries todo notes, comments and the activity history with its attribution', async () => {
    expect(await count(target, 'task_notes')).toBe((fixture.taskNotes?.length ?? 0) + 1) // + the replaced external ref
    expect(await count(target, 'task_comments')).toBe(fixture.taskComments?.length)
    const events = await sql(target, 'select * from task_activity_events')
    expect(events).toHaveLength(fixture.taskEvents?.length ?? -1)
    for (const want of (fixture.taskEvents ?? []).slice(0, 12)) {
      expect(events.find((e) => e.id === want.id)).toMatchObject({
        event: want.event,
        actor_id: want.actor_id,
        actor_type: want.actor_type,
        created_at: want.created_at,
        task_id: want.task_id,
        subject_id: want.subject_id,
      })
    }
    // The deleted todo's event kept its place in the feed, taskless.
    const deleted = events.find((e) => e.event === 'task_deleted')
    expect(deleted?.task_id).toBeNull()
    expect(deleted?.project_id).not.toBeNull()
    // The comment trigger indexed the comments.
    const [indexed] = await sql(target, `select count(*)::int as n from tasks where comments_text is not null`)
    expect(indexed?.n).toBeGreaterThan(0)
  })

  it('writes the mapping file for the personal-Cairn rewrite', () => {
    expect(mapping.applied).toBe(true)
    expect(Object.keys(mapping.subjects)).toHaveLength(19)
    expect(mapping.subjects['S-1']).toBe('LAB-1')
    expect(mapping.subjects['S-20']).toBe('LAB-20')
    expect(mapping.subjects['S-15']).toBeUndefined()
    expect(Object.keys(mapping.todos)).toHaveLength(63)
    expect(mapping.todos['T-13']).toBe('TRIG-1')
    expect(mapping.todos['T-17']).toBe('CROFT-1')
    expect(mapping.todos['T-1']).toBe('LT-1')
    expect(mapping.external_refs['croft:croft.montytorr.com/T-13']).toBe('TRIG-1')
  })

  it('maps to refs that exist', async () => {
    const refs = (await sql(target, `select p.key || '-' || t.number as ref from tasks t join projects p on p.id = t.project_id`)).map(
      (r) => r.ref,
    )
    expect(new Set(refs)).toEqual(new Set(Object.values(mapping.todos)))
  })

  it('leaves task numbering ready: the next todo in LT is LT-42', async () => {
    const [home] = await sql(target, `select id from projects where key = 'LT'`)
    const [next] = await probe(
      target,
      `insert into tasks (project_id, title, actor_type, actor_id, assignee_user_id)
       values ($1, 'next', 'human', 'test', $2) returning number`,
      [home?.id, CAL],
    )
    expect(next?.number).toBe(42)
  })

  it('refuses to run again into a target that now holds subjects', async () => {
    const before = await count(target, 'tasks')
    const again = await run(target, names.croftTemplate, { apply: true })
    expect(again.exitCode).toBe(1)
    expect(again.report.errors.join('\n')).toMatch(/already holds \d+ subject/)
    expect(await count(target, 'tasks')).toBe(before)
  })
})

describe('--rewrite-refs', () => {
  it('a dry run without it shows what it would do, with a sample, and changes nothing', async () => {
    const target = await freshDb('ci_rw_dry', names.targetTemplate)
    const result = await run(target, names.croftTemplate)
    expect(result.report.rewrites?.applied).toBe(false)
    expect(result.report.rewrites?.totals.rewritten).toBeGreaterThan(0)
    expect(result.report.rewrites?.sample).toHaveLength(10)
    expect(result.text).toMatch(/would rewrite/)
    expect(result.text).toMatch(/10 of \d+ rewrites/)
    await untouched(target)
  })

  it('rewrites prose refs to LAB-n and the new todo ref, and not code or links', async () => {
    const target = await freshDb('ci_rw', names.targetTemplate)
    const result = await run(target, names.croftTemplate, { apply: true, options: { rewriteRefs: true } })
    expect(result.exitCode).toBe(0)
    expect(result.report.rewrites?.applied).toBe(true)

    const [s3] = await sql(target, `select body from subjects where number = 3`)
    const body = String(s3?.body)
    expect(body).toContain('a link to LAB-1 and LT-3.')
    expect(body).toContain('The old `S-1` stays in code')
    expect(body).toContain('https://croft.montytorr.com/subjects/S-4')
    expect(body).toContain('T-3 in a fence')
    expect(body).toContain('Buy T-shirts for LAB-1.')

    // T-14 was "Do the thing for S-1. Blocked by T-13." and T-13 is TRIG-1.
    const [t14] = await sql(target, `select description from tasks where id = $1`, [fixture.tasks?.find((t) => t.number === 14)?.id])
    expect(t14?.description).toBe('Do the thing for LAB-1. Blocked by TRIG-1.')

    // The server's own triggers now see them as mentions.
    const [mentions] = await sql(
      target,
      `select (select count(*)::int from subject_mentions) as subjects, (select count(*)::int from task_mentions) as tasks`,
    )
    expect(Number(mentions?.subjects)).toBeGreaterThan(0)
    expect(Number(mentions?.tasks)).toBeGreaterThan(0)
  })
})

describe('refusals', () => {
  it('refuses a target that already holds subjects, and writes nothing', async () => {
    const target = await freshDb('ci_refuse', names.targetTemplate)
    const [stage] = await sql(target, 'select id from lab_stages limit 1')
    await sql(target, `insert into subjects (title, stage_id, actor_type, actor_id) values ('mine', $1, 'human', 'me')`, [stage?.id])
    const result = await run(target, names.croftTemplate, { apply: true })
    expect(result.exitCode).toBe(1)
    expect(result.report.verdict).toBe('blocked')
    expect(result.report.errors.join('\n')).toContain('already holds 1 subject')
    expect(await count(target, 'subjects')).toBe(1)
    expect(await count(target, 'tasks')).toBe(0)
    expect(await count(target, 'app_users')).toBe(0)
  })

  it('refuses a target that has no Lab, naming the migrations to run', async () => {
    const target = await freshDb('ci_nolab', names.preLabTemplate)
    const result = await run(target, names.croftTemplate, { apply: true })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/not migrated to the Lab/)
  })

  it('refuses the same database twice, and the same connection string', async () => {
    const target = await freshDb('ci_same', names.targetTemplate)
    expect((await run(target, target)).report.errors.join('\n')).toMatch(/same connection string|same database/)
    // Two spellings of one database.
    const spelled = await importCroft({ croftUrl: `${urlFor(target)}?application_name=again`, targetUrl: urlFor(target) })
    expect(spelled.exitCode).toBe(1)
    expect(spelled.report.errors.join('\n')).toMatch(/same database/)
  })

  it('refuses a source that is not a Croft database', async () => {
    const target = await freshDb('ci_notcroft', names.targetTemplate)
    const result = await run(target, names.preLabTemplate)
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/Croft/)
    await untouched(target)
  })

  it('refuses private subjects, and --allow-private lets them through', async () => {
    const croft = await freshDb('ci_private', names.croftTemplate)
    await sql(croft, `update subjects set visibility = 'private' where number = 5`)
    const target = await freshDb('ci_private_t', names.targetTemplate)
    const refused = await run(target, croft, { apply: true })
    expect(refused.exitCode).toBe(1)
    expect(refused.report.errors.join('\n')).toContain('S-5 private')
    await untouched(target)

    const allowed = await run(target, croft, { apply: true, options: { allowPrivate: true } })
    expect(allowed.exitCode).toBe(0)
    expect(await count(target, 'subjects')).toBe(19)
  })

  it('does not overwrite a mapping file', async () => {
    const target = await freshDb('ci_map', names.targetTemplate)
    const dir = await tempDir()
    const mappingFile = join(dir, 'mapping.json')
    await writeFile(mappingFile, 'mine')
    const result = await run(target, names.croftTemplate, { apply: true, mappingFile })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toContain('already exists')
    expect(await readFile(mappingFile, 'utf8')).toBe('mine')
    await untouched(target)
  })

  it('refuses a project key the target already uses', async () => {
    const target = await freshDb('ci_key', names.targetTemplate)
    const [owner] = await sql(target, `insert into app_users (email, encrypted_password) values ('op@example.test', 'x') returning id`)
    await sql(target, `insert into projects (owner_user_id, key, title) values ($1, 'TRIG', 'Mine')`, [owner?.id])
    const result = await run(target, names.croftTemplate, { apply: true })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/TRIG.*already uses/)
    expect(await count(target, 'subjects')).toBe(0)
  })

  it('rolls everything back when the target refuses a row', async () => {
    // Croft has no length limit on a log note; the Lab's is 100 000.
    const croft = await freshDb('ci_toolong', names.croftTemplate)
    await sql(croft, `update subject_notes set note = repeat('x', 100001) where id = $1`, [fixture.subjectNotes?.[0]?.id])
    const target = await freshDb('ci_toolong_t', names.targetTemplate)
    const result = await run(target, croft, { apply: true })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/target refused the import/)
    await untouched(target)
  })
})

describe('users already in the target', () => {
  it('matches by email, keeps the target user as is and attributes their work to them', async () => {
    const target = await freshDb('ci_users', names.targetTemplate)
    const [operator] = await sql(
      target,
      `insert into app_users (email, encrypted_password, role) values ($1, 'target-hash', 'admin') returning id`,
      [CAL_EMAIL.toUpperCase()],
    )
    const result = await run(target, names.croftTemplate, { apply: true })
    expect(result.exitCode).toBe(0)
    const users = await sql(target, 'select id, email, encrypted_password from app_users order by email')
    expect(users).toHaveLength(2)
    expect(users.find((u) => u.id === operator?.id)?.encrypted_password).toBe('target-hash')
    const [owned] = await sql(target, `select count(*)::int as n from subjects where owner_user_id = $1`, [operator?.id])
    expect(owned?.n).toBeGreaterThan(0)
    const projects = await sql(target, `select distinct owner_user_id from projects`)
    expect(projects).toEqual([{ owner_user_id: operator?.id }])
  })
})

describe('attachments', () => {
  let croft: string
  let sourceDir: string
  const files = croftFixture({ attachments: true })

  beforeAll(async () => {
    croft = await freshDb('ci_att', names.croftTemplate)
    const client = new pg.Client({ connectionString: urlFor(croft) })
    await client.connect()
    for (const [table, key] of [
      ['subject_attachments', 'subjectAttachments'],
      ['task_attachments', 'taskAttachments'],
    ] as const) {
      const rows = files.fixture[key] ?? []
      await client.query(
        `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`,
        [JSON.stringify(rows)],
      )
    }
    await client.end()
    sourceDir = await tempDir()
    for (const [path, bytes] of files.files) {
      await mkdir(join(sourceDir, path, '..'), { recursive: true })
      await writeFile(join(sourceDir, path), bytes)
    }
  })

  it('refuses attachments with no source store', async () => {
    const target = await freshDb('ci_att_nostore', names.targetTemplate)
    const result = await run(target, croft, { apply: true })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/no source store/)
    await untouched(target)
  })

  it('copies the bytes between stores and the rows point at them', async () => {
    const target = await freshDb('ci_att_ok', names.targetTemplate)
    const targetDir = await tempDir()
    const result = await run(target, croft, {
      apply: true,
      stores: { source: diskStore(sourceDir), target: diskStore(targetDir) },
    })
    expect(result.report.errors).toEqual([])
    expect(result.exitCode).toBe(0)

    const [sa] = await sql(target, 'select * from subject_attachments')
    expect(String(sa?.storage_path)).toMatch(/^lab\/subjects\//)
    expect((await readFile(join(targetDir, String(sa?.storage_path)))).toString()).toBe('subject file bytes\n')
    const [ta] = await sql(target, 'select * from task_attachments')
    expect((await readFile(join(targetDir, String(ta?.storage_path)))).toString()).toBe('task file bytes\n')
    expect(sa?.sha256).toBe(files.fixture.subjectAttachments?.[0]?.sha256)
    // The source is only read.
    expect((await readFile(join(sourceDir, String(files.fixture.subjectAttachments?.[0]?.storage_path)))).length).toBeGreaterThan(0)
  })

  it('a dry run reads the files but copies none', async () => {
    const target = await freshDb('ci_att_dry', names.targetTemplate)
    const targetDir = await tempDir()
    const result = await run(target, croft, { stores: { source: diskStore(sourceDir), target: diskStore(targetDir) } })
    expect(result.exitCode).toBe(0)
    expect(result.report.files).toMatchObject({ count: 2 })
    expect(await readdir(targetDir)).toEqual([])
    await untouched(target)
  })

  it('a missing source file blocks the import before anything is written', async () => {
    const target = await freshDb('ci_att_missing', names.targetTemplate)
    const emptySource = await tempDir()
    const result = await run(target, croft, {
      apply: true,
      stores: { source: diskStore(emptySource), target: diskStore(await tempDir()) },
    })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/cannot be read/)
    await untouched(target)
  })

  it('removes the files it copied when the transaction fails afterwards', async () => {
    const target = await freshDb('ci_att_fail', names.targetTemplate)
    // The events are written after the files are copied. A check nothing can
    // satisfy, enforced for new rows, fails the import at exactly that point.
    await sql(target, `alter table task_activity_events add constraint zz_never check (false) not valid`)
    const targetDir = await tempDir()
    const result = await run(target, croft, {
      apply: true,
      stores: { source: diskStore(sourceDir), target: diskStore(targetDir) },
    })
    expect(result.exitCode).toBe(1)
    expect(result.report.errors.join('\n')).toMatch(/zz_never/)
    await untouched(target)
    // Not the files only: the directories it made are gone too.
    expect(await readdir(targetDir)).toEqual([])
  })
})

describe('Croft is only read', () => {
  it('leaves the Croft database exactly as it was', async () => {
    const croft = await freshDb('ci_ro', names.croftTemplate)
    const tables = ['subjects', 'subject_notes', 'tasks', 'task_notes', 'task_activity_events', 'app_users']
    const snapshot = async () =>
      Promise.all(
        tables.map(async (t) => (await sql(croft, `select md5(string_agg(x::text, '|' order by x::text)) as h from ${t} x`))[0]?.h),
      )
    const before = await snapshot()
    const target = await freshDb('ci_ro_t', names.targetTemplate)
    expect((await run(target, croft, { apply: true })).exitCode).toBe(0)
    expect(await snapshot()).toEqual(before)
  })
})

describe('the vendored Croft schema', () => {
  const migrationsDir = process.env.CROFT_MIGRATIONS_DIR
  it.skipIf(!migrationsDir)('matches the columns Croft\'s own migrations build', async () => {
    const db = await freshDb('ci_croft_m', 'template0')
    await migrate(urlFor(db), { dir: migrationsDir ?? '', log: () => {} })
    const columns = (name: string) =>
      sql(
        name,
        `select table_name, column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name <> '_cairn_migrations' order by 1, 2`,
      )
    expect(await columns(names.croftTemplate)).toEqual(await columns(db))
  }, 120_000)
})
