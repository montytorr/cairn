import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The project move (CAIRN-385) against real databases: a "personal" and a
 * "croft" Cairn, both built from this repo's migrations, seeded with the
 * shapes the real ones hold (Lab mirrors, colliding keys, crossing links,
 * knowledge in every scope, sessions, files), and a third database standing
 * for the Croft the Lab was imported from. Each test works on fresh copies.
 *
 * Needs CREATE DATABASE on DATABASE_URL's server. It never touches the
 * database DATABASE_URL names.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

type Row = Record<string, unknown>
type Check = { name: string; ok: boolean; detail: string }
type Report = {
  verdict: string
  errors: string[]
  warnings: string[]
  verification?: Check[]
  rewrites?: { fields: { mode: string; owner: string; changes: { from: string; to: string }[] }[] }
  mirrors?: { merged: { mirror: string; real: string }[]; renumbered: { from: string; to: string }[] }
}
type Result = { report: Report; text: string; mapping: Row | null; exitCode: number }
type Store = {
  describe: string
  read: (path: string) => Promise<Buffer>
  write: (path: string, bytes: Buffer) => Promise<void>
  remove: (path: string) => Promise<void>
}
type MoveInput = {
  fromUrl: string
  toUrl: string
  keep: string
  move: string
  apply?: boolean
  options?: Row
  stores?: { source: Store | null; target: Store | null }
  mappingFile?: string | null
}

const load = <T>(path: string) => import(/* @vite-ignore */ join(process.cwd(), path)) as Promise<T>
const { moveProjects } = await load<{ moveProjects: (i: MoveInput) => Promise<Result> }>('scripts/move-projects.mjs')
const { migrate } = await load<{ migrate: (url: string, o: { dir: string; log: () => void }) => Promise<number> }>(
  'scripts/migrate.mjs',
)
const { diskStore } = await load<{ diskStore: (dir: string) => Store }>('scripts/import-croft/files.mjs')
const { rawTypes } = await load<{ rawTypes: pg.ClientConfig['types'] }>('scripts/import-croft/read.mjs')

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const created: string[] = []
const scratch: string[] = []

const urlFor = (db: string) => {
  const u = new URL(databaseUrl)
  u.pathname = `/${db}`
  return u.toString()
}
const admin = () => new pg.Client({ connectionString: urlFor('postgres') })
// Typed as non-empty so `[0]` reads cleanly; an empty result fails the assertion that reads it.
const sql = async <T extends Row = Row>(db: string, text: string, params: unknown[] = []): Promise<[T, ...T[]]> => {
  const client = new pg.Client({ connectionString: urlFor(db), types: rawTypes, options: '-c timezone=UTC' })
  await client.connect()
  try {
    return (await client.query(text, params)).rows as [T, ...T[]]
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
const fresh = async (prefix: string, template: string) => {
  const name = `${prefix}_${suffix}_${randomUUID().slice(0, 8)}`
  await createDb(name, template)
  return name
}
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'move-projects-it-'))
  scratch.push(dir)
  return dir
}

const PERSONAL_CAL = '11111111-1111-4111-8111-111111111111'
const CROFT_CAL = '22222222-2222-4222-8222-222222222222'
const MAEL = '33333333-3333-4333-8333-333333333333'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = { AT: id(1), CAIRN: id(2), TRIG: id(3), OLD: id(4) }
const T = {
  AT1: id(101),
  AT2: id(102),
  CAIRN1: id(201),
  CAIRN2: id(202),
  CAIRN3: id(203),
  TRIG1: id(301),
  TRIG2: id(302),
  TRIG3: id(303),
  OLD1: id(401),
}
const C = { LT: id(501), TRIG: id(502), mirrorTRIG1: id(601), extraTRIG2: id(602), mirrorLT1: id(603), plainLT2: id(604) }
const SUBJECT = id(701)
const CREATED = '2026-09-01 10:00:00.123456+00'
const UPDATED = '2026-09-02 11:30:00.654321+00'
const FILE_BYTES = Buffer.from('a file that moves with CAIRN-1')
const FILE_PATH = `${P.CAIRN}/tasks/${T.CAIRN1}/abc-note.txt`

const seedPersonal = async (db: string) => {
  await sql(
    db,
    `insert into app_users (id, email, encrypted_password, role) values ($1, 'Cal@Example.com', 'x', 'admin')`,
    [PERSONAL_CAL],
  )
  await sql(
    db,
    `insert into projects (id, owner_user_id, key, title, status, task_counter, external_ref) values
       ($1, $5, 'AT', 'Asha', 'active', 3, null), ($2, $5, 'CAIRN', 'Cairn', 'active', 7, 'BBTRADE:Cairn'),
       ($3, $5, 'TRIG', 'Trig', 'active', 3, null), ($4, $5, 'OLD', 'Old', 'archived', 1, null)`,
    [P.AT, P.CAIRN, P.TRIG, P.OLD, PERSONAL_CAL],
  )
  await sql(db, `insert into project_former_keys (owner_user_id, key, project_id, new_key) values ($1, 'CAI', $2, 'CAIRN')`, [
    PERSONAL_CAL,
    P.CAIRN,
  ])
  await sql(db, `insert into project_repos (project_id, owner_user_id, remote) values ($1, $2, 'github.com/x/cairn')`, [P.CAIRN, PERSONAL_CAL])
  const task = (tid: string, project: string, number: number, title: string, extra: Row = {}) =>
    sql(
      db,
      `insert into tasks (id, project_id, number, title, description, actor_type, actor_id, created_at, updated_at,
                          parent_id, external_ref, external_url, claimed_by, claimed_at, status, resolution, resolution_kind)
       values ($1, $2, $3, $4, $5, 'agent', 'claude-code · cal', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        tid,
        project,
        number,
        title,
        extra.description ?? null,
        CREATED,
        UPDATED,
        extra.parent ?? null,
        extra.external_ref ?? null,
        extra.external_url ?? null,
        extra.claimed_by ?? null,
        extra.claimed_by ? CREATED : null,
        extra.status ?? 'todo',
        extra.resolution ?? null,
        extra.resolution ? 'fixed' : null,
      ],
    )
  await task(T.AT1, P.AT, 1, 'Asha one', { description: 'see CAIRN-1' })
  await task(T.CAIRN1, P.CAIRN, 1, 'Cairn one', { description: 'needs CAIRN-2 and AT-1, CAI-2 too', claimed_by: 'claude-code · cal', status: 'doing' })
  await task(T.AT2, P.AT, 2, 'Asha two, child of CAIRN-1', {
    parent: T.CAIRN1,
    external_url: 'https://tasks.example.com/projects/CAIRN/tasks/1',
  })
  await task(T.CAIRN2, P.CAIRN, 2, 'Cairn two', {
    parent: T.CAIRN1,
    resolution: 'done, see CAIRN-1',
    status: 'done',
    external_ref: 'croft.example.com/LT-1',
    external_url: 'https://croft.example.com/projects/LT/tasks/1',
  })
  await task(T.CAIRN3, P.CAIRN, 7, 'Cairn three, child of AT-1', { parent: T.AT1 })
  await task(T.TRIG1, P.TRIG, 1, 'Trig one')
  await task(T.TRIG2, P.TRIG, 2, 'Trig two')
  await task(T.TRIG3, P.TRIG, 3, 'Trig three, handed from the Lab', {
    external_ref: 'croft:croft.example.com/T-1',
    external_url: 'https://croft.example.com/projects/T/tasks/1',
  })
  await task(T.OLD1, P.OLD, 1, 'Old one')
  await sql(db, `insert into task_projects (task_id, project_id) values ($1, $2)`, [T.CAIRN1, P.AT])
  // Former refs: CAIRN-3 moves with its task, AT-3 stays behind with AT, CAIRN-4 names a task that stays.
  await sql(db, `insert into task_former_refs (project_id, number, task_id) values ($1, 3, $3), ($2, 3, $4), ($1, 4, $5)`, [
    P.CAIRN,
    P.AT,
    T.CAIRN1,
    T.CAIRN3,
    T.AT1,
  ])
  await sql(db, `insert into task_deps (blocked_id, blocking_id) values ($1, $2), ($3, $4)`, [T.CAIRN1, T.CAIRN2, T.AT1, T.CAIRN2])
  await sql(
    db,
    `insert into task_notes (task_id, actor_type, actor_id, note, kind, content_hash, created_at) values
       ($1, 'agent', 'a', 'a finding about CAIRN-2', 'finding', 'h1', $3),
       ($2, 'agent', 'a', 'trig note', 'note', 'h2', $3)`,
    [T.CAIRN1, T.TRIG3, CREATED],
  )
  await sql(db, `insert into task_comments (task_id, actor_type, actor_id, content, created_at) values ($1, 'human', 'cal', 'a comment', $2)`, [
    T.CAIRN1,
    CREATED,
  ])
  await sql(
    db,
    `insert into task_attachments (task_id, actor_type, actor_id, filename, original_name, mime_type, size_bytes, storage_path, sha256)
     values ($1, 'agent', 'a', 'abc-note.txt', 'note.txt', 'text/plain', $2, $3, $4)`,
    [T.CAIRN1, FILE_BYTES.length, FILE_PATH, createHash('sha256').update(FILE_BYTES).digest('hex')],
  )
  await sql(
    db,
    `insert into task_activity_events (task_id, project_id, owner_user_id, actor_type, actor_id, event, data, created_at) values
       ($1, $2, $3, 'agent', 'a', 'git_commit', '{"sha":"abc"}', $4),
       (null, $2, $3, 'human', 'cal', 'task_deleted', '{"ref":"CAIRN-5"}', $4),
       ($5, $6, $3, 'agent', 'a', 'created', '{}', $4)`,
    [T.CAIRN1, P.CAIRN, PERSONAL_CAL, CREATED, T.AT1, P.AT],
  )
  await sql(
    db,
    `insert into entities (id, owner_user_id, key, title) values ($1, $2, 'clawdius', 'Clawdius')`,
    [id(801), PERSONAL_CAL],
  )
  await sql(db, `insert into project_entities (project_id, entity_id) values ($1, $3), ($2, $3)`, [P.CAIRN, P.AT, id(801)])
  // Sessions: one in CAIRN, one elsewhere that touched a CAIRN file and an AT task.
  await sql(
    db,
    `insert into sessions (id, owner_user_id, external_id, platform_source, project_id, request) values
       ($1, $3, 'sess-cairn', 'claude', $4, 'work on cairn'), ($2, $3, 'sess-at', 'claude', $5, 'work on asha')`,
    [id(901), id(902), PERSONAL_CAL, P.CAIRN, P.AT],
  )
  await sql(
    db,
    `insert into file_touches (owner_user_id, path, task_id, session_id, project_id) values
       ($1, 'src/a.ts', $2, $3, $4), ($1, 'src/b.ts', $5, $3, $6), ($1, 'src/c.ts', null, $3, $4)`,
    [PERSONAL_CAL, T.CAIRN1, id(901), P.CAIRN, T.AT1, P.AT],
  )
  // Knowledge in every scope.
  const k = (kid: string, slug: string, superseded: string | null = null, sourceTask: string | null = null) =>
    sql(
      db,
      `insert into knowledge (id, owner_user_id, slug, title, body, superseded_by, source_task_id, source_session_id, created_at, updated_at)
       values ($1, $2, $3, $3, 'body of ' || $3 || ' in \`src/a.ts\`', $4, $5, $6, $7, $8)`,
      [kid, PERSONAL_CAL, slug, superseded, sourceTask, slug === 'moves' ? id(902) : null, CREATED, UPDATED],
    )
  await k(id(1001), 'global-fact', null, T.CAIRN1)
  await k(id(1002), 'moves')
  await k(id(1003), 'stays')
  await k(id(1004), 'both')
  await k(id(1005), 'moves-superseded-by-global', id(1001))
  await k(id(1006), 'moves-superseded-by-moves', id(1002))
  await sql(
    db,
    `insert into knowledge_projects (knowledge_id, project_id) values
       ($1, $5), ($2, $6), ($3, $5), ($3, $6), ($4, $5), ($7, $5)`,
    [id(1002), id(1003), id(1004), id(1005), P.CAIRN, P.AT, id(1006)],
  )
  await sql(db, `insert into knowledge_entities (knowledge_id, entity_id) values ($1, $2)`, [id(1002), id(801)])
  await sql(db, `insert into knowledge_reads (owner_user_id, actor_id, slug, hit) values ($1, 'a', 'moves', true), ($1, 'a', 'stays', true)`, [
    PERSONAL_CAL,
  ])
}

const seedCroft = async (db: string) => {
  await sql(
    db,
    `insert into app_users (id, email, encrypted_password, role) values ($1, 'cal@example.com', 'y', 'admin'), ($2, 'mael@example.com', 'z', 'member')`,
    [CROFT_CAL, MAEL],
  )
  await sql(
    db,
    `insert into projects (id, owner_user_id, key, title, task_counter, handoff_tracker, handoff_target) values
       ($1, $3, 'LT', 'Lab todos', 3, null, null), ($2, $3, 'TRIG', 'Trig', 3, 'cairn', 'TRIG')`,
    [C.LT, C.TRIG, CROFT_CAL],
  )
  await sql(db, `update lab_settings set enabled = true, home_project_id = $1`, [C.LT])
  const stage = (await sql<{ id: string }>(db, `select id from lab_stages order by position limit 1`))[0].id
  await sql(
    db,
    `insert into subjects (id, number, title, body, stage_id, project_id, owner_user_id, actor_type, actor_id) values
       ($1, 1, 'Trig subject', 'TRIG-1 pushed to Cairn as TRIG-3. LT-1 too.', $2, $3, $4, 'human', 'cal')`,
    [SUBJECT, stage, C.TRIG, CROFT_CAL],
  )
  await sql(
    db,
    `insert into subject_notes (id, subject_id, kind, note, actor_type, actor_id) values ($1, $2, 'handoff', 'TRIG-1 handed off as TRIG-3, edited by hand', 'agent', 'a')`,
    [id(711), SUBJECT],
  )
  const task = (tid: string, project: string, number: number, title: string, handoff: [string, string] | null, extRef: string) =>
    sql(
      db,
      `insert into tasks (id, project_id, number, title, actor_type, actor_id, subject_id, handoff_tracker, handoff_ref, handoff_url, handoff_status, external_ref)
       values ($1, $2, $3, $4, 'agent', 'a', $5, $6, $7, $8, $9, $10)`,
      [
        tid,
        project,
        number,
        title,
        SUBJECT,
        handoff ? 'cairn' : null,
        handoff?.[0] ?? null,
        handoff?.[1] ?? null,
        handoff ? 'todo' : null,
        extRef,
      ],
    )
  await task(C.mirrorTRIG1, C.TRIG, 1, 'Mirror of TRIG-3', ['TRIG-3', 'https://tasks.example.com/projects/TRIG/tasks/3'], 'croft:croft.example.com/T-1')
  await task(C.extraTRIG2, C.TRIG, 2, 'A lab todo filed in TRIG', null, 'croft:croft.example.com/T-2')
  await task(C.mirrorLT1, C.LT, 1, 'Mirror of CAIRN-2', ['CAIRN-2', 'https://tasks.example.com/projects/CAIRN/tasks/2'], 'croft:croft.example.com/T-3')
  await task(C.plainLT2, C.LT, 2, 'Plain lab todo, after TRIG-1 and LT-1', null, 'croft:croft.example.com/T-4')
  // LT-3 was the mirror of CAIRN-2 before it moved; TRIG-3 names a todo in the TRIG the real one replaces.
  await sql(db, `insert into task_former_refs (project_id, number, task_id) values ($1, 3, $3), ($2, 3, $4)`, [
    C.LT,
    C.TRIG,
    C.mirrorLT1,
    C.extraTRIG2,
  ])
  await sql(
    db,
    `insert into task_notes (task_id, actor_type, actor_id, note, kind, content_hash) values
       ($1, 'human', 'mael', 'Mael on the mirror', 'note', 'm1'), ($1, 'agent', 'a', 'trig note', 'note', 'h2')`,
    [C.mirrorTRIG1],
  )
  await sql(
    db,
    `insert into task_activity_events (task_id, project_id, owner_user_id, actor_type, actor_id, event, data, subject_id)
     values ($1, $2, $3, 'agent', 'a', 'handed_off', '{"ref":"TRIG-1"}', $4)`,
    [C.mirrorTRIG1, C.TRIG, CROFT_CAL, SUBJECT],
  )
}

/** The Croft the Lab was imported from: only the tables and columns the move reads. */
const seedOrigin = async (db: string) => {
  await sql(
    db,
    `create table subjects (id uuid primary key, title text, body text, conclusion text);
     create table subject_notes (id uuid primary key, note text);
     create table subject_human_notes (id uuid primary key, body text);
     create table tasks (id uuid primary key, title text, description text, resolution text);
     create table task_notes (id uuid primary key, note text);
     create table task_comments (id uuid primary key, content text)`,
  )
  await sql(db, `insert into subjects values ($1, 'Trig subject', 'T-1 pushed to Cairn as TRIG-3. T-3 too.', null)`, [SUBJECT])
  await sql(db, `insert into subject_notes values ($1, 'T-1 handed off as TRIG-3')`, [id(711)])
  await sql(db, `insert into tasks values ($1, 'Plain lab todo, after T-1 and T-3', null, null)`, [C.plainLT2])
}

const names = { template: `mv_tpl_${suffix}`, personal: `mv_personal_${suffix}`, croft: `mv_croft_${suffix}`, origin: `mv_origin_${suffix}` }
let mappingDir: string

beforeAll(async () => {
  await createDb(names.template)
  await migrate(urlFor(names.template), { dir: join(process.cwd(), 'migrations'), log: () => {} })
  await createDb(names.personal, names.template)
  await seedPersonal(names.personal)
  await createDb(names.croft, names.template)
  await seedCroft(names.croft)
  await createDb(names.origin)
  await seedOrigin(names.origin)
  mappingDir = await tempDir()
  await writeFile(
    join(mappingDir, 'croft-mapping.json'),
    JSON.stringify({ subjects: { 'S-1': 'LAB-1' }, todos: { 'T-1': 'TRIG-1', 'T-2': 'TRIG-2', 'T-3': 'LT-1', 'T-4': 'LT-2' } }),
  )
}, 120_000)

afterAll(async () => {
  const client = admin()
  await client.connect()
  for (const name of created) await client.query(`drop database if exists "${name}" with (force)`)
  await client.end()
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })))
})

const KEEP = 'AT'
const MOVE = 'CAIRN,TRIG'
let personal: string
let croft: string
let stores: { source: Store; target: Store; targetDir: string }

beforeEach(async () => {
  personal = await fresh('mv_p', names.personal)
  croft = await fresh('mv_c', names.croft)
  const from = await tempDir()
  const to = await tempDir()
  await mkdir(dirname(join(from, FILE_PATH)), { recursive: true })
  await writeFile(join(from, FILE_PATH), FILE_BYTES)
  stores = { source: diskStore(from), target: diskStore(to), targetDir: to }
})

const run = (extra: Partial<MoveInput> = {}) =>
  moveProjects({
    fromUrl: urlFor(personal),
    toUrl: urlFor(croft),
    keep: KEEP,
    move: MOVE,
    stores,
    options: {
      sourceBaseUrl: 'https://tasks.example.com',
      targetBaseUrl: 'https://croft.example.com',
      labOrigin: urlFor(names.origin),
      labMapping: join(mappingDir, 'croft-mapping.json'),
    },
    ...extra,
  })

const fingerprint = async (db: string) => {
  const tables = ['projects', 'tasks', 'task_notes', 'task_comments', 'task_activity_events', 'sessions', 'file_touches', 'knowledge', 'knowledge_projects', 'subjects', 'subject_notes', 'task_mentions']
  const out: Record<string, string> = {}
  for (const t of tables) out[t] = (await sql<{ d: string }>(db, `select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) as d from ${t} x`))[0].d
  return out
}

const failed = (r: Result) => (r.report.verification ?? []).filter((c) => !c.ok)

describe('a dry run', () => {
  it('runs the whole move, passes its checks, and changes nothing on either side', async () => {
    const before = [await fingerprint(personal), await fingerprint(croft)]
    const r = await run()
    expect(r.report.errors).toEqual([])
    expect(failed(r)).toEqual([])
    expect(r.report.verdict).toBe('dry-run')
    expect(r.exitCode).toBe(0)
    expect(r.report.warnings).toContain('OLD is archived and not kept, so it moves too')
    expect([await fingerprint(personal), await fingerprint(croft)]).toEqual(before)
    expect(await readFile(join(stores.targetDir, FILE_PATH)).catch(() => null)).toBe(null)
  })
})

describe('it refuses', () => {
  it('an active project nobody decided about', async () => {
    const r = await run({ move: 'CAIRN' })
    expect(r.report.verdict).toBe('blocked')
    expect(r.report.errors).toContain('TRIG (active) is neither kept nor named in --move: decide about it first')
  })

  it('a person the target does not have, when a moving row names them', async () => {
    const stranger = (await sql(personal, `insert into app_users (email, encrypted_password) values ('stranger@example.com', 'x') returning id`))[0].id
    await sql(personal, `update tasks set assignee_user_id = $1 where id = $2`, [stranger, T.CAIRN1])
    const r = await run()
    expect(r.report.errors).toContain(
      'stranger@example.com has no account on the target and 1 moving row(s) name them: users are matched by email',
    )
  })

  it('knowledge that exists on both sides', async () => {
    await sql(croft, `insert into knowledge (owner_user_id, slug, title) values ($1, 'moves', 'already here')`, [CROFT_CAL])
    const r = await run()
    expect(r.report.errors).toContain('knowledge moves exists on both sides')
  })

  it('attachments with no store to read them from', async () => {
    const r = await run({ stores: { source: null, target: null } })
    expect(r.report.errors).toContain('1 attachment(s) move and no --from-files-dir is given')
  })

  it('a mapping file that is already there', async () => {
    const file = join(await tempDir(), 'mapping.json')
    await writeFile(file, '{}')
    const r = await run({ mappingFile: file })
    expect(r.report.errors[0]).toMatch(/already exists/)
  })
})

describe('an applied move', () => {
  it('moves everything, merges the mirrors, and leaves personal with what it keeps', async () => {
    const file = join(await tempDir(), 'mapping.json')
    const times = (await sql(personal, `select created_at, updated_at from tasks where id = $1`, [T.CAIRN1]))[0]
    const files = await sql(
      personal,
      `select k.slug, f.path, f.origin from knowledge_files f join knowledge k on k.id = f.knowledge_id
        where k.slug in ('both', 'moves', 'moves-superseded-by-global', 'moves-superseded-by-moves') order by 1, 2, 3`,
    )
    const r = await run({ apply: true, mappingFile: file })
    expect(r.report.errors).toEqual([])
    expect(failed(r)).toEqual([])
    expect(r.report.verdict).toBe('applied')

    // Personal keeps AT, with its own rows intact and the links that crossed dropped and noted.
    expect((await sql(personal, `select key from projects order by key`)).map((p) => p.key)).toEqual(['AT'])
    expect((await sql(personal, `select count(*)::int as n from tasks`))[0].n).toBe(2)
    const at2 = (await sql(personal, `select parent_id, external_url from tasks where id = $1`, [T.AT2]))[0]
    expect(at2).toEqual({ parent_id: null, external_url: 'https://croft.example.com/projects/CAIRN/tasks/1' })
    expect((await sql(personal, `select note from task_notes where task_id = $1`, [T.AT2]))[0].note).toMatch(/parent CAIRN-1 moved to croft/)
    expect((await sql(personal, `select slug from knowledge order by slug`)).map((k) => k.slug)).toEqual(['both', 'global-fact', 'stays'])
    expect((await sql(personal, `select source_task_id from knowledge where slug = 'global-fact'`))[0].source_task_id).toBe(null)
    expect((await sql(personal, `select external_id from sessions`)).map((s) => s.external_id)).toEqual(['sess-at'])
    expect(await sql(personal, `select path, task_id, session_id from file_touches`)).toEqual([{ path: 'src/b.ts', task_id: T.AT1, session_id: null }])
    expect((await sql(personal, `select count(*)::int as n from task_activity_events`))[0].n).toBe(1)
    expect((await sql(personal, `select slug from knowledge_reads`)).map((x) => x.slug)).toEqual(['stays'])

    // Croft has the projects, ids, numbers, users mapped by email, and times to the microsecond.
    expect((await sql(croft, `select key from projects order by key`)).map((p) => p.key)).toEqual(['CAIRN', 'LT', 'OLD', 'TRIG'])
    const cairn1 = (
      await sql(croft, `select project_id, number, assignee_user_id, created_at, updated_at, claimed_by, comments_text from tasks where id = $1`, [T.CAIRN1])
    )[0]
    expect(cairn1).toEqual({
      project_id: P.CAIRN,
      number: 1,
      assignee_user_id: CROFT_CAL,
      created_at: '2026-09-01 10:00:00.123456+00',
      updated_at: times.updated_at,
      claimed_by: 'claude-code · cal',
      comments_text: 'a comment',
    })
    expect((await sql(croft, `select parent_id from tasks where id = $1`, [T.CAIRN2]))[0].parent_id).toBe(T.CAIRN1)
    expect((await sql(croft, `select parent_id from tasks where id = $1`, [T.CAIRN3]))[0].parent_id).toBe(null)
    expect((await sql(croft, `select note from task_notes where task_id = $1 and actor_id like 'move-projects%'`, [T.CAIRN3]))[0].note).toMatch(/parent AT-1 stayed/)
    expect(await sql(croft, `select count(*)::int as n from task_projects`)).toEqual([{ n: 0 }])
    expect(await sql(croft, `select blocked_id, blocking_id from task_deps`)).toEqual([{ blocked_id: T.CAIRN1, blocking_id: T.CAIRN2 }])
    expect((await sql(croft, `select key from project_former_keys`)).map((k) => k.key)).toEqual(['CAI'])
    // A former ref moves with its task, follows a merged mirror to the real task, and goes with a replaced project.
    expect(await sql(croft, `select project_id, number, task_id from task_former_refs order by project_id`)).toEqual([
      { project_id: P.CAIRN, number: 3, task_id: T.CAIRN1 },
      { project_id: C.LT, number: 3, task_id: T.CAIRN2 },
    ])
    expect(await sql(personal, `select count(*)::int as n from task_former_refs`)).toEqual([{ n: 0 }])
    expect((await sql(croft, `select key from entities`)).map((k) => k.key)).toEqual(['clawdius'])
    expect((await sql(croft, `select project_id from project_entities`)).map((k) => k.project_id)).toEqual([P.CAIRN])

    // Knowledge: moved, copied with its moving scope only, the cross-line supersede named in the body.
    expect((await sql(croft, `select slug from knowledge order by slug`)).map((k) => k.slug)).toEqual([
      'both',
      'moves',
      'moves-superseded-by-global',
      'moves-superseded-by-moves',
    ])
    expect((await sql(croft, `select p.key from knowledge_projects kp join knowledge k on k.id = kp.knowledge_id join projects p on p.id = kp.project_id where k.slug = 'both'`)).map((x) => x.key)).toEqual(['CAIRN'])
    const orphan = (await sql(croft, `select superseded_by, body from knowledge where slug = 'moves-superseded-by-global'`))[0]
    expect(orphan.superseded_by).toBe(null)
    expect(orphan.body).toMatch(/Superseded by `global-fact`, which stayed on https:\/\/tasks\.example\.com/)
    expect((await sql(croft, `select superseded_by from knowledge where slug = 'moves-superseded-by-moves'`))[0].superseded_by).toBe(id(1002))
    expect((await sql(croft, `select source_session_id, source_session_ref from knowledge where slug = 'moves'`))[0]).toEqual({
      source_session_id: null,
      source_session_ref: 'sess-at',
    })
    expect(
      await sql(croft, `select k.slug, f.path, f.origin from knowledge_files f join knowledge k on k.id = f.knowledge_id order by 1, 2, 3`),
    ).toEqual(files)
    expect(files.length).toBeGreaterThan(0)

    // Sessions and their touches.
    expect((await sql(croft, `select external_id, project_id from sessions`))).toEqual([{ external_id: 'sess-cairn', project_id: P.CAIRN }])
    expect((await sql(croft, `select path from file_touches order by path`)).map((f) => f.path)).toEqual(['src/a.ts', 'src/c.ts'])

    // The mirror of TRIG-3 is gone; TRIG-3 has its subject, Mael's note and its history.
    const trig3 = (await sql(croft, `select subject_id, external_ref from tasks where id = $1`, [T.TRIG3]))[0]
    expect(trig3).toEqual({ subject_id: SUBJECT, external_ref: null })
    expect((await sql(croft, `select external_ref, external_url from tasks where id = $1`, [T.CAIRN2]))[0]).toEqual({
      external_ref: null,
      external_url: null,
    })
    const notes = (await sql(croft, `select actor_id, note from task_notes where task_id = $1 order by note`, [T.TRIG3])).map((n) => n.note)
    expect(notes).toContain('Mael on the mirror')
    expect(notes.filter((n) => n === 'trig note')).toHaveLength(1)
    const merge = notes.find((n) => /^Merged the Lab mirror/.test(String(n)))
    expect(merge).toBe(
      "Merged the Lab mirror of this task into it when TRIG moved from personal Cairn to croft (CAIRN-385). " +
        "The mirror was TRIG\u20111 on croft (number 1 in the Lab's TRIG project), first Croft's T-1 (croft:croft.example.com/T-1). " +
        'Its subject link (LAB-1), notes and history are now on this task. ' +
        "This task's links to the mirror were cleared: external_ref croft:croft.example.com/T-1, external_url https://croft.example.com/projects/T/tasks/1.",
    )
    // The mirror's old ref, written into the note, is not a mention of the real TRIG-1.
    expect(
      await sql(croft, `select count(*)::int as n from task_mentions m join tasks t on t.id = m.target_task_id where t.id = $1`, [T.TRIG1]),
    ).toEqual([{ n: 0 }])
    const event = (await sql(croft, `select project_id, data from task_activity_events where event = 'handed_off'`))[0]
    expect(event).toMatchObject({ project_id: P.TRIG, data: { ref: 'TRIG-3', merged_from: 'TRIG-1' } })
    expect(await sql(croft, `select count(*)::int as n from tasks where id in ($1, $2)`, [C.mirrorTRIG1, C.mirrorLT1])).toEqual([{ n: 0 }])
    expect((await sql(croft, `select subject_id from tasks where id = $1`, [T.CAIRN2]))[0].subject_id).toBe(SUBJECT)

    // The lab todo that was not a mirror joins the real TRIG after its last number.
    expect((await sql(croft, `select p.key, t.number from tasks t join projects p on p.id = t.project_id where t.id = $1`, [C.extraTRIG2]))[0]).toEqual({
      key: 'TRIG',
      number: 4,
    })
    expect((await sql(croft, `select task_counter from projects where id = $1`, [P.TRIG]))[0].task_counter).toBe(4)
    expect((await sql(croft, `select project_id from subjects`))[0].project_id).toBe(P.TRIG)

    // Mirror refs in the Lab's text now name the real tasks; a real ref written as such stays.
    expect((await sql(croft, `select body from subjects`))[0].body).toBe('TRIG-3 pushed to Cairn as TRIG-3. CAIRN-2 too.')
    expect((await sql(croft, `select title from tasks where id = $1`, [C.plainLT2]))[0].title).toBe('Plain lab todo, after TRIG-3 and CAIRN-2')
    // An edited note cannot be rebuilt from the origin: every mirror ref is rewritten, and flagged.
    expect((await sql(croft, `select note from subject_notes`))[0].note).toBe('TRIG-3 handed off as TRIG-3, edited by hand')
    expect(r.report.rewrites?.fields.filter((f) => f.mode === 'ambiguous').map((f) => f.owner)).toEqual(['LAB-1'])

    // Mentions are rebuilt from the text on croft, former keys included.
    const mentions = await sql(
      croft,
      `select ps.key || '-' || s.number as "from", pt.key || '-' || t.number as "to", m.source, m.ref_as_written
         from task_mentions m join tasks s on s.id = m.source_task_id join tasks t on t.id = m.target_task_id
         join projects ps on ps.id = s.project_id join projects pt on pt.id = t.project_id order by 1, 2, 3`,
    )
    expect(mentions).toEqual([
      { from: 'CAIRN-1', to: 'CAIRN-2', source: 'description', ref_as_written: 'CAI-2' },
      { from: 'CAIRN-1', to: 'CAIRN-2', source: 'note', ref_as_written: 'CAIRN-2' },
      { from: 'CAIRN-2', to: 'CAIRN-1', source: 'resolution', ref_as_written: 'CAIRN-1' },
    ])
    expect((await sql(croft, `select count(*)::int as n from subject_mentions`))[0].n).toBeGreaterThan(0)

    // The file is in the target store; the mapping file says what moved.
    expect(await readFile(join(stores.targetDir, FILE_PATH))).toEqual(FILE_BYTES)
    const mapping = JSON.parse(await readFile(file, 'utf8'))
    expect(mapping).toMatchObject({ applied: true, mirrors: { 'TRIG-1': 'TRIG-3', 'LT-1': 'CAIRN-2' }, renumbered: { 'TRIG-2': 'TRIG-4' } })
    expect(Object.keys(mapping.projects).sort()).toEqual(['CAIRN', 'OLD', 'TRIG'])

    // A second run finds nothing left to move.
    const again = await run()
    expect(again.report.verdict).toBe('blocked')
  })
})

describe('moving a project back', () => {
  it('takes an archived project from croft to personal, leaving behind a person personal never had', async () => {
    await sql(personal, `insert into app_users (email, encrypted_password) values ('stranger@example.com', 'x')`)
    const there = await run({ apply: true })
    expect(there.report.verdict).toBe('applied')
    expect(there.report.warnings).toContain('stranger@example.com has no account on the target; nothing that moves names them')
    await sql(croft, `update tasks set parent_id = $1 where id = $2`, [T.CAIRN1, T.OLD1])
    await sql(croft, `insert into task_notes (task_id, actor_type, actor_id, note, kind) values ($1, 'agent', 'claude-code · cal', 'old note', 'note')`, [
      T.OLD1,
    ])

    const back = await moveProjects({
      fromUrl: urlFor(croft),
      toUrl: urlFor(personal),
      keep: 'CAIRN,LT,TRIG',
      move: 'OLD',
      apply: true,
      stores: { source: stores.target, target: stores.source },
      options: {
        sourceBaseUrl: 'https://croft.example.com',
        targetBaseUrl: 'https://tasks.example.com',
        sourceName: 'croft',
        targetName: 'personal Cairn',
        task: 'CAIRN-389',
      },
    })
    expect(back.report.errors).toEqual([])
    expect(failed(back)).toEqual([])
    expect(back.report.verdict).toBe('applied')
    expect(back.report.warnings).toContain('mael@example.com has no account on the target; nothing that moves names them')

    expect((await sql(croft, `select key from projects order by key`)).map((p) => p.key)).toEqual(['CAIRN', 'LT', 'TRIG'])
    expect((await sql(personal, `select key, status from projects order by key`))).toEqual([
      { key: 'AT', status: 'active' },
      { key: 'OLD', status: 'archived' },
    ])
    expect((await sql(personal, `select project_id, number, parent_id from tasks where id = $1`, [T.OLD1]))[0]).toEqual({
      project_id: P.OLD,
      number: 1,
      parent_id: null,
    })
    const notes = (await sql(personal, `select actor_id, note from task_notes where task_id = $1 order by note`, [T.OLD1]))
    expect(notes).toEqual([
      {
        actor_id: 'move-projects · CAIRN-389',
        note: 'Its parent CAIRN-1 stayed on croft when this project moved to personal Cairn (CAIRN-389), so the sub-task link was dropped: https://croft.example.com/projects/CAIRN/tasks/1',
      },
      { actor_id: 'claude-code · cal', note: 'old note' },
    ])
  })
})

describe('a session recorded on both sides', () => {
  it('keeps the target row, fills in what it lacks, and points the moved touches at it', async () => {
    const there = id(950)
    await sql(croft, `insert into sessions (id, owner_user_id, external_id, platform_source, learned) values ($1, $2, 'sess-cairn', 'claude', 'from croft')`, [
      there,
      CROFT_CAL,
    ])
    const r = await run({ apply: true })
    expect(failed(r)).toEqual([])
    expect(r.report.verdict).toBe('applied')
    expect(await sql(croft, `select id, request, learned, project_id from sessions`)).toEqual([
      { id: there, request: 'work on cairn', learned: 'from croft', project_id: P.CAIRN },
    ])
    expect((await sql(croft, `select distinct session_id from file_touches where session_id is not null`)).map((x) => x.session_id)).toEqual([there])
  })
})
