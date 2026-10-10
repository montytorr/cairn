import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Croft importer's mapping rules (CAIRN-369), tested without a database:
 * `buildPlan` is a pure function of a Croft snapshot, what the target holds and
 * the options. The write path, and what the target's real constraints say, is
 * tests/integration/croft-import.test.ts.
 */

type Row = Record<string, unknown>
type Snapshot = {
  counter: number
  users: Row[]
  stages: Row[]
  tags: Row[]
  labProjects: Row[]
  subjects: Row[]
  subjectTags: Row[]
  subjectNotes: Row[]
  subjectHumanNotes: Row[]
  subjectAttachments: Row[]
  projects: Row[]
  tasks: Row[]
  taskNotes: Row[]
  taskComments: Row[]
  taskEvents: Row[]
  taskAttachments: Row[]
  [key: string]: unknown
}
type Counts = Record<string, { source: number; insert?: number; reuse?: number; update?: number; skipped?: number }>
type Plan = {
  errors: string[]
  warnings: string[]
  notes: string[]
  counts: Counts
  mapping: { subjects: Record<string, string>; todos: Record<string, string> }
  subjects: { total: number; archived: number; highest: number; croftCounter: number; counterAfter: number; gaps: number[] }
  todos: {
    total: number
    perProject: Record<string, number>
    statuses: Record<string, number>
    handoff: { byTracker: Record<string, number>; derivedUrls: number; open: number; ended: number }
    claimsCleared: number
    releasedToTodo: number
  }
  users: { email: string; action: string; id: string }[]
  stages: { name: string; action: string; detail: string }[]
  projects: { name: string; key: string; source: string }[]
  skipped: { what: string; count: number; why: string }[]
  rows: {
    app_users: Row[]
    lab_stages: { insert: Row[]; update: Row[] }
    lab_tags: Row[]
    projects: Row[]
    lab_settings: Row
    subjects: Row[]
    subject_notes: Row[]
    subject_attachments: Row[]
    tasks: Row[]
    task_notes: Row[]
    task_activity_events: Row[]
  }
  files: { kind: string; from: string; to: string }[]
  counterAfter: number
  rewrites: {
    applied: boolean
    byTable: Record<string, { fields: number; rewritten: number; left: number; unknown: number }>
    totals: { rewritten: number; left: number; unknown: number }
    unknown: string[]
    sample: { table: string; owner: string; field: string; from: string; to: string; before: string; after: string }[]
  }
}
type Target = {
  users: { id: string; email: string; role: string }[]
  stages: { id: string; name: string; category: string; color: string; position: number }[]
  tags: { id: string; name: string }[]
  projects: { id: string; key: string; task_counter: number }[]
  formerKeys: string[]
  settings: { home_project_id: string | null } | null
  eventKinds: Set<string> | null
}
type PlanModule = {
  buildPlan: (args: { croft: Snapshot; target: Target; options?: Record<string, unknown> }) => Plan
  rewriteRefs: (text: string, subjects: Map<string, string>, todos: Map<string, string>) => string
  contentHash: (kind: string, note: string) => string
  parseProjectKeys: (pairs: string[]) => { keys: Map<string, string>; errors: string[] }
}
type FilesModule = {
  diskStore: (root: string) => Store
  copyFiles: (args: { source: Store; target: Store; files: FileSpec[] }) => Promise<string[]>
  checkSource: (store: Store, files: FileSpec[]) => Promise<{ problems: string[] }>
}
type Store = {
  describe: string
  read: (path: string) => Promise<Buffer>
  write: (path: string, bytes: Buffer) => Promise<void>
  remove: (path: string) => Promise<void>
}
type RefsModule = {
  scanRefs: (
    text: string | null,
    subjects: Map<string, string>,
    todos: Map<string, string>,
  ) => {
    text: string | null
    rewritten: { from: string; to: string }[]
    left: { ref: string }[]
    unknown: string[]
  }
}
type FileSpec = { kind?: string; from: string; to: string; sha256: string | null; size: number }
type ReportModule = { maskUrl: (url: string) => string }
type FixtureModule = {
  croftFixture: (o?: { attachments?: boolean }) => { fixture: Snapshot; files: Map<string, Buffer> }
}

// Paths, not literals, so the type checker does not go looking for declarations
// of plain .mjs files.
const load = <T>(path: string) => import(/* @vite-ignore */ join(process.cwd(), path)) as Promise<T>
const plan = await load<PlanModule>('scripts/import-croft/plan.mjs')
const refsLib = await load<RefsModule>('scripts/import-croft/refs.mjs')
const filesLib = await load<FilesModule>('scripts/import-croft/files.mjs')
const report = await load<ReportModule>('scripts/import-croft/report.mjs')
const { croftFixture } = await load<FixtureModule>('tests/fixtures/croft/fixture.mjs')

const SEEDED = [
  ['to explore', 'planned', '#8a8792'],
  ['exploring', 'active', '#6b7fa6'],
  ['done', 'completed', '#5f8a63'],
  ['rejected', 'dropped', '#a0685f'],
  ['to implement', 'planned', '#8f8a74'],
  ['implementing', 'active', '#a88a4e'],
  ['internal testing', 'active', '#86709e'],
  ['ready for rollout', 'active', '#4f8c86'],
  ['rolled out', 'completed', '#4e7f5a'],
] as const

const freshTarget = (over: Partial<Target> = {}): Target => ({
  users: [],
  stages: SEEDED.map(([name, category, color], i) => ({
    id: `7000000${i}-0000-4000-8000-000000000000`,
    name,
    category,
    color,
    position: i,
  })),
  tags: [],
  projects: [],
  formerKeys: [],
  settings: { home_project_id: null },
  eventKinds: null,
  ...over,
})

const fixture = (): Snapshot => structuredClone(croftFixture().fixture)
const run = (croft: Snapshot = fixture(), target: Target = freshTarget(), options: Record<string, unknown> = {}) =>
  plan.buildPlan({ croft, target, options })

const task = (croft: Snapshot, number: number) => {
  const found = croft.tasks.find((t) => t.number === number)
  if (!found) throw new Error(`no fixture task ${number}`)
  return found
}
const subject = (croft: Snapshot, number: number) => {
  const found = croft.subjects.find((s) => s.number === number)
  if (!found) throw new Error(`no fixture subject ${number}`)
  return found
}

describe('the fixture is the real shape', () => {
  it('has the counts the real database has', () => {
    const f = fixture()
    expect(f.subjects).toHaveLength(19)
    expect(f.stages).toHaveLength(9)
    expect(f.tags).toHaveLength(4)
    expect(f.labProjects).toHaveLength(2)
    expect(f.users).toHaveLength(2)
    expect(f.tasks).toHaveLength(63)
    expect(f.tasks.filter((t) => t.handoff_tracker)).toHaveLength(41)
    expect(f.subjectAttachments).toHaveLength(0)
    expect(f.taskAttachments).toHaveLength(0)
    expect(f.subjectHumanNotes).toHaveLength(2)
    expect(f.subjects.every((s) => s.visibility === 'lab')).toBe(true)
  })
})

describe('subjects keep their numbers', () => {
  it('maps S-n to LAB-n with the same number and leaves the deleted one out', () => {
    const p = run()
    expect(p.errors).toEqual([])
    expect(Object.keys(p.mapping.subjects)).toHaveLength(19)
    expect(p.mapping.subjects['S-1']).toBe('LAB-1')
    expect(p.mapping.subjects['S-20']).toBe('LAB-20')
    expect(p.mapping.subjects['S-15']).toBeUndefined()
    expect(p.rows.subjects.map((s) => s.number)).toEqual(
      [...Array(20).keys()].map((i) => i + 1).filter((n) => n !== 15),
    )
  })

  it('ends the counter past the highest number, deleted ones included', () => {
    const p = run()
    expect(p.subjects).toMatchObject({ highest: 20, croftCounter: 20, counterAfter: 20, gaps: [15], archived: 2 })
    expect(p.counterAfter).toBe(20)

    const croft = fixture()
    croft.counter = 23 // S-21 to S-23 were created and deleted
    const later = run(croft)
    expect(later.counterAfter).toBe(23)
    expect(later.subjects.gaps).toEqual([15, 21, 22, 23])
  })

  it('keeps every field, the author and the times', () => {
    const croft = fixture()
    const p = run(croft)
    const s3 = p.rows.subjects.find((s) => s.number === 3)
    const from = subject(croft, 3)
    expect(s3).toMatchObject({
      id: from.id,
      title: from.title,
      body: from.body,
      conclusion: from.conclusion,
      position: from.position,
      actor_type: from.actor_type,
      actor_id: from.actor_id,
      created_at: from.created_at,
      updated_at: from.updated_at,
      archived_at: null,
    })
    expect(p.rows.subjects.find((s) => s.number === 6)?.archived_at).toBe(subject(croft, 6).archived_at)
  })

  it('keeps the timestamp text, microseconds and all', () => {
    const p = run()
    expect(String(p.rows.subjects[0]?.created_at)).toMatch(/\.\d{6}\+00$/)
  })
})

describe('the log', () => {
  it('turns Croft visibility notes into plain notes and keeps every other kind', () => {
    const croft = fixture()
    const p = run(croft)
    const kinds = (rows: Row[]) => rows.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.kind)]: (m[String(r.kind)] ?? 0) + 1 }), {})
    expect(kinds(croft.subjectNotes).visibility).toBe(3)
    const after = kinds(p.rows.subject_notes)
    expect(after.visibility).toBeUndefined()
    expect(after.note).toBe((kinds(croft.subjectNotes).note ?? 0) + 3)
    expect(after.stage).toBe(kinds(croft.subjectNotes).stage)
    expect(p.rows.subject_notes).toHaveLength(croft.subjectNotes.length)
  })

  it('keeps Croft content hashes, and computes the API formula when there is none', () => {
    const croft = fixture()
    const first = croft.subjectNotes[0]
    if (!first) throw new Error('fixture has no notes')
    const original = first.content_hash
    const without = croft.subjectNotes[1]
    if (!without) throw new Error('fixture has one note')
    without.content_hash = null
    const p = run(croft)
    expect(p.rows.subject_notes.find((n) => n.id === first.id)?.content_hash).toBe(original)
    expect(p.rows.subject_notes.find((n) => n.id === without.id)?.content_hash).toBe(
      plan.contentHash(String(without.kind), String(without.note)),
    )
  })

  it('refuses a log kind the Lab does not know', () => {
    const croft = fixture()
    const first = croft.subjectNotes[0]
    if (!first) throw new Error('fixture has no notes')
    first.kind = 'rumour'
    expect(run(croft).errors.join('\n')).toContain('"rumour"')
  })
})

describe('todos', () => {
  it('files each todo under its subject\'s project, or the home project', () => {
    const croft = fixture()
    const p = run(croft)
    const key = (id: unknown) => p.rows.projects.find((r) => r.id === id)?.key
    const byKey = (n: number) => key(p.rows.tasks.find((t) => t.id === task(croft, n).id)?.project_id)
    expect(byKey(13)).toBe('TRIG') // S-1, a Trig subject
    expect(byKey(17)).toBe('CROFT') // S-4
    expect(byKey(1)).toBe('LT') // S-17, no lab project
    expect(byKey(60)).toBe('LT') // no subject at all
    expect(p.rows.tasks.find((t) => t.id === task(croft, 60).id)?.subject_id).toBeNull()
  })

  it('numbers them from 1 in each project, in Croft order, and maps T-n to the new ref', () => {
    const p = run()
    expect(Object.keys(p.mapping.todos)).toHaveLength(63)
    expect(new Set(Object.values(p.mapping.todos)).size).toBe(63)
    expect(p.mapping.todos['T-13']).toBe('TRIG-1')
    expect(p.mapping.todos['T-14']).toBe('TRIG-2')
    expect(p.mapping.todos['T-17']).toBe('CROFT-1')
    expect(p.mapping.todos['T-1']).toBe('LT-1')
    expect(p.todos.perProject).toEqual({ TRIG: 18, CROFT: 4, LT: 41 })
    const taskCounters = Object.fromEntries(p.rows.projects.map((r) => [r.key, r.task_counter]))
    expect(taskCounters).toEqual({ TRIG: 18, CROFT: 4, LT: 41 })
  })

  it('numbers after what an existing home project already holds', () => {
    const home = { id: '90000000-0000-4000-8000-000000000001', key: 'LT', task_counter: 5 }
    const p = run(fixture(), freshTarget({ projects: [home], settings: { home_project_id: home.id } }))
    expect(p.errors).toEqual([])
    expect(p.mapping.todos['T-1']).toBe('LT-6')
    expect(p.rows.projects.some((r) => r.key === 'LT')).toBe(false)
  })

  it('sets external_ref to the Croft ref and keeps one it replaces in a note', () => {
    const croft = fixture()
    const p = run(croft)
    const t1 = p.rows.tasks.find((t) => t.id === task(croft, 1).id)
    expect(t1?.external_ref).toBe('croft:croft.montytorr.com/T-1')
    const t60 = p.rows.tasks.find((t) => t.id === task(croft, 60).id)
    expect(t60?.external_ref).toBe('croft:croft.montytorr.com/T-60')
    expect(p.warnings.join('\n')).toContain('https://example.test/issue/60')
    expect(p.rows.task_notes.some((n) => n.task_id === task(croft, 60).id && String(n.note).includes('example.test/issue/60'))).toBe(true)
    expect(run(croft, freshTarget(), { croftHost: 'croft.example.test' }).rows.tasks[0]?.external_ref).toMatch(
      /^croft:croft\.example\.test\/T-/,
    )
  })

  it('clears claims, and sends a claimed doing todo back to todo unless the tracker owns its status', () => {
    const croft = fixture()
    const p = run(croft)
    expect(p.rows.tasks.every((t) => t.claimed_by === null && t.claimed_at === null && t.heartbeat_at === null && t.claimed_session === null)).toBe(true)
    expect(p.todos.claimsCleared).toBe(3)
    const status = (n: number) => p.rows.tasks.find((t) => t.id === task(croft, n).id)?.status
    expect(task(croft, 50)).toMatchObject({ status: 'doing', handoff_tracker: null })
    expect(status(50)).toBe('todo')
    expect(p.todos.releasedToTodo).toBe(1)
  })

  it('keeps status, priority, type, assignee, resolution and checkpoint', () => {
    const croft = fixture()
    const p = run(croft)
    const from = task(croft, 4)
    const to = p.rows.tasks.find((t) => t.id === from.id)
    expect(to).toMatchObject({
      priority: from.priority,
      type: from.type,
      assignee_user_id: from.assignee_user_id,
      resolution: from.resolution,
      resolution_kind: from.resolution_kind,
      resolved_by: from.resolved_by,
      checkpoint_summary: from.checkpoint_summary,
      created_at: from.created_at,
      updated_at: from.updated_at,
      actor_id: from.actor_id,
      labels: from.labels,
    })
  })

  it('inserts a parent before its sub-tasks even when it has the higher number', () => {
    const croft = fixture()
    expect(task(croft, 2).parent_id).toBe(task(croft, 4).id)
    const p = run(croft)
    const order = p.rows.tasks.map((t) => t.id)
    expect(order.indexOf(task(croft, 4).id)).toBeLessThan(order.indexOf(task(croft, 2).id))
    expect(order.indexOf(task(croft, 8).id)).toBeLessThan(order.indexOf(task(croft, 9).id)) // duplicate_of
  })

  it('refuses a parent cycle', () => {
    const croft = fixture()
    task(croft, 4).parent_id = task(croft, 2).id
    expect(run(croft).errors.join('\n')).toMatch(/cycle/)
  })

  it('carries notes, comments and every activity event, attributing them as before', () => {
    const croft = fixture()
    const p = run(croft)
    expect(p.counts.task_comments).toMatchObject({ source: croft.taskComments.length, insert: croft.taskComments.length })
    expect(p.counts.task_activity_events).toMatchObject({ source: croft.taskEvents.length, insert: croft.taskEvents.length })
    const created = p.rows.task_activity_events.find((e) => e.id === croft.taskEvents[0]?.id)
    expect(created).toMatchObject({ actor_id: croft.taskEvents[0]?.actor_id, created_at: croft.taskEvents[0]?.created_at, subject_id: croft.taskEvents[0]?.subject_id })
    // The event of a deleted todo has no task, and is filed with the home project.
    const deleted = p.rows.task_activity_events.find((e) => e.event === 'task_deleted')
    expect(deleted?.task_id).toBeNull()
    expect(deleted?.project_id).toBe(p.rows.lab_settings.home_project_id)
  })

  it('skips, and reports, an event kind the target does not know', () => {
    const croft = fixture()
    const known = new Set(croft.taskEvents.map((e) => String(e.event)))
    known.delete('task_deleted')
    const p = run(croft, freshTarget({ eventKinds: known }))
    expect(p.counts.task_activity_events?.skipped).toBe(1)
    expect(p.skipped.find((s) => s.what === 'task_activity_events task_deleted')).toBeTruthy()
  })
})

describe('hand-offs', () => {
  it('carries tracker, ref, status and sync time, and gives a cairn link its absolute URL', () => {
    const croft = fixture()
    const p = run(croft)
    expect(p.todos.handoff.byTracker).toEqual({ cairn: 41 })
    expect(p.todos.handoff.derivedUrls).toBe(35)
    const t1 = task(croft, 1)
    const to = p.rows.tasks.find((t) => t.id === t1.id)
    expect(to).toMatchObject({
      handoff_tracker: 'cairn',
      handoff_ref: t1.handoff_ref,
      handoff_status: t1.handoff_status,
      handoff_synced_at: t1.handoff_synced_at,
      handoff_url: `https://tasks.montytorr.com/projects/KDP/tasks/${String(t1.handoff_ref).split('-')[1]}`,
    })
    // A link that had its URL keeps it.
    const t40 = task(croft, 40)
    expect(p.rows.tasks.find((t) => t.id === t40.id)?.handoff_url).toBe(t40.handoff_url)
    // And a todo that was never handed off stays clean.
    expect(p.rows.tasks.find((t) => t.id === task(croft, 50).id)).toMatchObject({
      handoff_tracker: null,
      handoff_ref: null,
      handoff_url: null,
    })
  })

  it('uses the instance named by --cairn-url', () => {
    const p = run(fixture(), freshTarget(), { cairnUrl: 'https://cairn.example.test/' })
    expect(p.rows.tasks.find((t) => t.handoff_ref === 'KDP-2')?.handoff_url).toBe(
      'https://cairn.example.test/projects/KDP/tasks/2',
    )
  })

  it('refuses a cairn hand-off whose URL cannot be known', () => {
    const croft = fixture()
    task(croft, 5).handoff_ref = 'not a ref'
    task(croft, 6).handoff_ref = 'weird'
    const errors = run(croft).errors.join('\n')
    expect(errors).toContain('T-5')
    expect(errors).toContain('T-6')
  })

  it('refuses a cairn URL that is not https, since the database would', () => {
    const croft = fixture()
    task(croft, 37).handoff_url = 'http://tasks.example.test/projects/KDP/tasks/1'
    expect(run(croft).errors.join('\n')).toMatch(/https/)
  })

  it('does not release an open hand-off\'s doing status', () => {
    const croft = fixture()
    const t = task(croft, 5)
    expect(t).toMatchObject({ status: 'doing', handoff_status: null })
    const to = run(croft).rows.tasks.find((r) => r.id === t.id)
    expect(to?.status).toBe('doing')
  })
})

describe('users', () => {
  it('copies users with their hashes and roles, and no keys or sessions', () => {
    const croft = fixture()
    const p = run(croft)
    expect(p.rows.app_users).toHaveLength(2)
    const cal = p.rows.app_users.find((u) => u.email === 'cal@example.test')
    expect(cal).toMatchObject({ role: 'admin', encrypted_password: croft.users[0]?.encrypted_password })
    expect(p.skipped.find((s) => s.what === 'api_keys')?.count).toBe(3)
  })

  it('matches an existing user by email and keeps theirs', () => {
    const existing = { id: '80000000-0000-4000-8000-000000000001', email: 'CAL@example.test', role: 'admin' }
    const croft = fixture()
    const p = run(croft, freshTarget({ users: [existing] }))
    expect(p.users.find((u) => u.email === 'cal@example.test')).toMatchObject({ action: 'reuse', id: existing.id })
    expect(p.rows.app_users.map((u) => u.email)).toEqual(['mael@example.test'])
    // Their subjects and todos are attributed to the user already there.
    expect(p.rows.subjects.find((s) => s.number === 1)?.owner_user_id).toBe(existing.id)
    expect(p.rows.tasks.every((t) => t.assignee_user_id)).toBe(true)
  })

  it('gives a user a fresh id when theirs belongs to someone else in the target', () => {
    const croft = fixture()
    const clash = { id: String(croft.users[1]?.id), email: 'someone@example.test', role: 'member' }
    const p = run(croft, freshTarget({ users: [clash] }))
    const mael = p.users.find((u) => u.email === 'mael@example.test')
    expect(mael?.action).toBe('insert')
    expect(mael?.id).not.toBe(clash.id)
  })

  it('owns the created projects by --owner, else the first admin', () => {
    expect(run().rows.projects[0]?.owner_user_id).toBe(fixture().users[0]?.id)
    const p = run(fixture(), freshTarget(), { ownerEmail: 'mael@example.test' })
    expect(p.rows.projects[0]?.owner_user_id).toBe(fixture().users[1]?.id)
    expect(run(fixture(), freshTarget(), { ownerEmail: 'nobody@example.test' }).errors.join()).toContain('nobody@example.test')
  })
})

describe('stages, tags and projects', () => {
  it('matches the seeded stages by name, whatever the case', () => {
    const croft = fixture()
    const target = freshTarget()
    const first = target.stages[0]
    if (!first) throw new Error('no seeded stage')
    first.name = 'To Explore'
    const p = run(croft, target)
    expect(p.counts.lab_stages).toMatchObject({ source: 9, insert: 0, reuse: 9, update: 0 })
    expect(p.rows.subjects.find((s) => s.number === 1)?.stage_id).toBe(first.id)
  })

  it('reconciles a stage Croft changed, and adds one the target lacks', () => {
    const croft = fixture()
    const rolled = croft.stages.find((s) => s.name === 'rolled out')
    if (!rolled) throw new Error('no stage')
    rolled.color = '#112233'
    croft.stages.push({ id: '20000000-0000-4000-8000-0000000000aa', name: 'parked', category: 'dropped', color: '#111111', position: 9, created_at: '2026-06-01 09:00:00+00', updated_at: '2026-06-01 09:00:00+00' })
    const target = freshTarget()
    target.stages.push({ id: '70000000-0000-4000-8000-0000000000ff', name: 'extra', category: 'active', color: '#222222', position: 12 })
    const p = run(croft, target)
    expect(p.counts.lab_stages).toMatchObject({ insert: 1, update: 1 })
    expect(p.rows.lab_stages.update[0]).toMatchObject({ color: '#112233' })
    expect(p.notes.join('\n')).toContain('extra')
  })

  it('creates a Cairn project for each lab project, keyed by its cairn hand-off target', () => {
    const p = run()
    expect(p.projects.map((x) => x.key).sort()).toEqual(['CROFT', 'LT', 'TRIG'])
    const trig = p.rows.projects.find((r) => r.key === 'TRIG')
    expect(trig).toMatchObject({ title: 'Trig', handoff_tracker: 'cairn', handoff_target: 'TRIG', status: 'active' })
    expect(p.rows.lab_settings).toMatchObject({ enabled: true, home_project_id: p.rows.projects.find((r) => r.key === 'LT')?.id })
  })

  it('asks for a key when a lab project has no cairn target, and takes --project-key', () => {
    const croft = fixture()
    const trig = croft.labProjects[0]
    if (!trig) throw new Error('no lab project')
    trig.handoff_tracker = 'github'
    trig.handoff_target = 'montytorr/trig'
    const refused = run(croft)
    expect(refused.errors.join('\n')).toContain('--project-key "Trig=KEY"')

    const { keys } = plan.parseProjectKeys(['trig=TRG'])
    const ok = run(croft, freshTarget(), { projectKeys: keys })
    expect(ok.errors).toEqual([])
    expect(ok.rows.projects.find((r) => r.title === 'Trig')).toMatchObject({ key: 'TRG', handoff_tracker: 'github', handoff_target: 'montytorr/trig' })
  })

  it('refuses a key the target uses, a retired one, LAB, and two projects on one key', () => {
    const taken = run(fixture(), freshTarget({ projects: [{ id: '90000000-0000-4000-8000-000000000009', key: 'TRIG', task_counter: 0 }] }))
    expect(taken.errors.join('\n')).toContain('already uses')
    const retired = run(fixture(), freshTarget({ formerKeys: ['CROFT'] }))
    expect(retired.errors.join('\n')).toContain('already uses')

    const lab = fixture()
    const first = lab.labProjects[0]
    if (!first) throw new Error('no lab project')
    first.handoff_target = 'LAB'
    expect(run(lab).errors.join('\n')).toContain('reserved')

    const both = fixture()
    const second = both.labProjects[1]
    if (!second) throw new Error('no lab project')
    second.handoff_target = 'TRIG'
    expect(run(both).errors.join('\n')).toMatch(/both take the key TRIG/)
  })

  it('refuses a home key that is some other project of the target', () => {
    const p = run(fixture(), freshTarget({ projects: [{ id: '90000000-0000-4000-8000-000000000001', key: 'LT', task_counter: 0 }] }))
    expect(p.errors.join('\n')).toContain('--home-key')
  })

  it('creates tags lower-cased and reuses one that is there', () => {
    const croft = fixture()
    const tag = croft.tags[0]
    if (!tag) throw new Error('no tag')
    tag.name = 'Search'
    const target = freshTarget({ tags: [{ id: '60000000-0000-4000-8000-000000000001', name: 'ai' }] })
    const p = run(croft, target)
    expect(p.rows.lab_tags.map((t) => t.name)).toEqual(['search', 'infra', 'growth'])
    expect(p.counts.lab_tags).toMatchObject({ insert: 3, reuse: 1 })
  })
})

describe('visibility', () => {
  it('refuses private subjects, since the Lab has no private subjects', () => {
    const croft = fixture()
    subject(croft, 9).visibility = 'private'
    subject(croft, 10).visibility = 'members'
    const p = run(croft)
    expect(p.errors.join('\n')).toContain('S-9 private')
    expect(p.errors.join('\n')).toContain('S-10 members')
    const allowed = run(croft, freshTarget(), { allowPrivate: true })
    expect(allowed.errors).toEqual([])
    expect(allowed.warnings.join('\n')).toContain('--allow-private')
  })
})

describe('attachments', () => {
  it('moves a subject file under lab/ and keeps a task file where it is', () => {
    const { fixture: croft } = croftFixture({ attachments: true })
    const p = run(croft)
    const subjectFile = p.files.find((f) => f.kind === 'subject')
    expect(subjectFile?.from).toMatch(/^subjects\//)
    expect(subjectFile?.to).toBe(`lab/${subjectFile?.from}`)
    expect(p.rows.subject_attachments[0]?.storage_path).toBe(subjectFile?.to)
    const taskFile = p.files.find((f) => f.kind === 'task')
    expect(taskFile?.to).toBe(taskFile?.from)
    expect(p.counts.task_attachments?.insert).toBe(1)
  })
})

describe('rewriting refs in prose', () => {
  const subjects = new Map([
    ['S-12', 'LAB-12'],
    ['S-3', 'LAB-3'],
  ])
  const todos = new Map([['T-5', 'TRIG-1']])
  const rewrite = (text: string) => plan.rewriteRefs(text, subjects, todos)

  it('rewrites whole tokens that exist and nothing else', () => {
    expect(rewrite('see S-12, T-5 and S-15; not TLS-1, UTF-8, ST-12 or S-120 or T-50')).toBe(
      'see LAB-12, TRIG-1 and S-15; not TLS-1, UTF-8, ST-12 or S-120 or T-50',
    )
    expect(rewrite('(S-12) **T-5**, S-3.')).toBe('(LAB-12) **TRIG-1**, LAB-3.')
    expect(rewrite('Buy T-shirts, T-5shirts, S-12-b and the S-3rd')).toBe('Buy T-shirts, T-5shirts, S-12-b and the S-3rd')
  })

  it('leaves code alone: inline, fenced and indented', () => {
    expect(rewrite('use `S-12` or ``T-5 `x` ``, but S-12 here')).toBe('use `S-12` or ``T-5 `x` ``, but LAB-12 here')
    expect(rewrite('before S-3\n```sh\ncairn show S-12\n```\nafter S-3')).toBe(
      'before LAB-3\n```sh\ncairn show S-12\n```\nafter LAB-3',
    )
    expect(rewrite('~~~\nT-5\n~~~\nT-5')).toBe('~~~\nT-5\n~~~\nTRIG-1')
    expect(rewrite('text\n\n    S-12 as code\n\nS-12 as prose')).toBe('text\n\n    S-12 as code\n\nLAB-12 as prose')
    // An unclosed fence runs to the end, as markdown does.
    expect(rewrite('S-3\n```\nS-3')).toBe('LAB-3\n```\nS-3')
  })

  it('leaves a list item alone as prose, even when it is indented', () => {
    expect(rewrite('- S-12\n    - S-3\n\n    still the list: S-12')).toBe(
      '- LAB-12\n    - LAB-3\n\n    still the list: LAB-12',
    )
  })

  it('leaves URLs, link targets, autolinks and tags alone, but not link text', () => {
    expect(rewrite('https://croft.montytorr.com/subjects/S-12 and S-12')).toBe(
      'https://croft.montytorr.com/subjects/S-12 and LAB-12',
    )
    expect(rewrite('croft.montytorr.com/projects/T/tasks/17?ref=T-5#S-12')).toBe(
      'croft.montytorr.com/projects/T/tasks/17?ref=T-5#S-12',
    )
    expect(rewrite('[S-12](https://croft.montytorr.com/s?x=S-12 "T-5") ![T-5](img/T-5.png)')).toBe(
      '[LAB-12](https://croft.montytorr.com/s?x=S-12 "T-5") ![TRIG-1](img/T-5.png)',
    )
    expect(rewrite('<https://x.test/S-12> and <a href="/s/S-3">S-3</a>')).toBe(
      '<https://x.test/S-12> and <a href="/s/S-3">LAB-3</a>',
    )
    expect(rewrite('[ref]: https://croft.montytorr.com/S-12\n\nS-12')).toBe(
      '[ref]: https://croft.montytorr.com/S-12\n\nLAB-12',
    )
    expect(rewrite('file S-12.md, #S-12, @T-5, a/S-3')).toBe('file S-12.md, #S-12, @T-5, a/S-3')
  })

  it('says what it rewrote, what it left in code or links, and what it could not map', () => {
    const scan = refsLib.scanRefs('S-12 `S-12` S-15 T-5 https://x.test/T-5', subjects, todos)
    expect(scan.text).toBe('LAB-12 `S-12` S-15 TRIG-1 https://x.test/T-5')
    expect(scan.rewritten).toHaveLength(2)
    // A ref inside a URL is not a ref to begin with, so it is not counted either.
    expect(scan.left.map((l) => l.ref)).toEqual(['S-12'])
    expect(scan.unknown).toEqual(['S-15'])
    expect(refsLib.scanRefs(null, subjects, todos)).toMatchObject({ text: null, rewritten: [] })
  })

  it('leaves text alone unless asked, and counts what it would do', () => {
    const croft = fixture()
    const p = run(croft)
    expect(p.rewrites.applied).toBe(false)
    expect(p.rewrites.totals.rewritten).toBeGreaterThan(0)
    expect(p.rows.subjects.find((s) => s.number === 1)?.body).toBe(subject(croft, 1).body)
    expect(p.rows.subjects.find((s) => s.number === 3)?.body).toBe(subject(croft, 3).body)

    const done = run(croft, freshTarget(), { rewriteRefs: true })
    expect(done.rewrites.applied).toBe(true)
    expect(done.rewrites.totals).toEqual(p.rewrites.totals)
    expect(String(done.rows.subjects.find((s) => s.number === 1)?.body)).toContain('LAB-2')
    expect(String(done.rows.subjects.find((s) => s.number === 1)?.body)).toContain('LT-1')
  })

  it('keeps the traps in a real subject body and rewrites the prose around them', () => {
    const body = String(run(fixture(), freshTarget(), { rewriteRefs: true }).rows.subjects.find((s) => s.number === 3)?.body)
    expect(body).toContain('link to LAB-1 and')
    expect(body).toContain('The old `S-1` stays in code')
    expect(body).toContain('[LAB-2](https://croft.montytorr.com/subjects/2)') // the text is prose, the target is not
    expect(body).toContain('https://croft.montytorr.com/subjects/S-4')
    expect(body).toContain('T-3 in a fence')
    expect(body).toContain('Buy T-shirts for LAB-1.')
  })

  it('reports counts per table and ten rewrites spread across them', () => {
    const p = run()
    const tables = Object.keys(p.rewrites.byTable)
    expect(tables).toEqual(expect.arrayContaining(['subjects', 'subject_notes', 'tasks', 'task_notes', 'task_comments']))
    const sum = Object.values(p.rewrites.byTable).reduce((n, t) => n + t.rewritten, 0)
    expect(sum).toBe(p.rewrites.totals.rewritten)
    expect(p.rewrites.sample).toHaveLength(10)
    expect(new Set(p.rewrites.sample.map((s) => s.table)).size).toBeGreaterThan(2)
    for (const s of p.rewrites.sample) {
      expect(s.before).toContain(s.from)
      expect(s.after).toContain(s.to)
      expect(s.after).not.toBe(s.before)
    }
    expect(p.rewrites.byTable.subjects?.left).toBeGreaterThan(0)
    expect(p.rewrites.unknown).toEqual([])
  })
})

describe('--project-key', () => {
  it('parses name=KEY pairs and reports a malformed one', () => {
    const ok = plan.parseProjectKeys(['Trig=TRG', ' my project = mp '])
    expect(ok.errors).toEqual([])
    expect(ok.keys.get('trig')).toBe('TRG')
    expect(ok.keys.get('my project')).toBe('MP')
    expect(plan.parseProjectKeys(['nokey', 'x=1']).errors).toHaveLength(2)
  })
})

describe('the report', () => {
  it('never prints a password', () => {
    expect(report.maskUrl('postgresql://cal:s3cret@db.example.test:5432/croft')).not.toContain('s3cret')
    expect(report.maskUrl('postgresql://cal:s3cret@db.example.test:5432/croft')).toContain('db.example.test')
  })
})

describe('attachment stores', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })
  const temp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'croft-import-'))
    dirs.push(d)
    return d
  }
  const sha = async (bytes: Buffer) => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(bytes).digest('hex')
  }

  it('copies bytes between stores and reports what it wrote', async () => {
    const [a, b] = [await temp(), await temp()]
    const bytes = Buffer.from('hello')
    await mkdir(join(a, 'x'), { recursive: true })
    await writeFile(join(a, 'x/file.txt'), bytes)
    const written = await filesLib.copyFiles({
      source: filesLib.diskStore(a),
      target: filesLib.diskStore(b),
      files: [{ from: 'x/file.txt', to: 'lab/subjects/s/file.txt', sha256: await sha(bytes), size: 5 }],
    })
    expect(written).toEqual(['lab/subjects/s/file.txt'])
    expect((await readFile(join(b, 'lab/subjects/s/file.txt'))).toString()).toBe('hello')
  })

  it('refuses a file that does not match its row, and writes nothing', async () => {
    const [a, b] = [await temp(), await temp()]
    await writeFile(join(a, 'f.txt'), 'tampered')
    const files = [{ from: 'f.txt', to: 'f.txt', sha256: await sha(Buffer.from('original')), size: 8 }]
    await expect(
      filesLib.copyFiles({ source: filesLib.diskStore(a), target: filesLib.diskStore(b), files }),
    ).rejects.toThrow(/sha256/)
    await expect(readFile(join(b, 'f.txt'))).rejects.toThrow()
  })

  it('treats the same bytes already there as copied, and different bytes as an error', async () => {
    const [a, b] = [await temp(), await temp()]
    await writeFile(join(a, 'f.txt'), 'one')
    await writeFile(join(b, 'f.txt'), 'one')
    const spec = { from: 'f.txt', to: 'f.txt', sha256: null, size: 3 }
    await expect(filesLib.copyFiles({ source: filesLib.diskStore(a), target: filesLib.diskStore(b), files: [spec] })).resolves.toEqual([])
    await writeFile(join(b, 'f.txt'), 'two')
    await expect(filesLib.copyFiles({ source: filesLib.diskStore(a), target: filesLib.diskStore(b), files: [spec] })).rejects.toThrow(/other bytes/)
  })

  it('removes what it wrote, and the directories it made, when a later write fails', async () => {
    const [a, b] = [await temp(), await temp()]
    await writeFile(join(a, 'good.txt'), 'good')
    // A directory that was there before the import, with a file of its own, stays.
    await mkdir(join(b, 'lab/subjects/kept'), { recursive: true })
    await writeFile(join(b, 'lab/subjects/kept/mine.txt'), 'mine')
    const disk = filesLib.diskStore(b)
    const failing = { ...disk, write: async (path: string, bytes: Buffer) => (path === 'boom' ? Promise.reject(new Error('disk full')) : disk.write(path, bytes)) }
    const files = [
      { from: 'good.txt', to: 'lab/subjects/s1/deep/good.txt', sha256: null, size: 4 },
      { from: 'good.txt', to: 'lab/subjects/kept/good.txt', sha256: null, size: 4 },
      { from: 'good.txt', to: 'boom', sha256: null, size: 4 },
    ]
    await expect(filesLib.copyFiles({ source: filesLib.diskStore(a), target: failing, files })).rejects.toThrow(/disk full/)
    expect(await readdir(join(b, 'lab/subjects'))).toEqual(['kept'])
    expect(await readdir(join(b, 'lab/subjects/kept'))).toEqual(['mine.txt'])
  })

  it('removes a copied file and its empty directories, up to the store root', async () => {
    const [a, b] = [await temp(), await temp()]
    await writeFile(join(a, 'f.txt'), 'x')
    const target = filesLib.diskStore(b)
    await filesLib.copyFiles({
      source: filesLib.diskStore(a),
      target,
      files: [{ from: 'f.txt', to: 'lab/subjects/s1/f.txt', sha256: null, size: 1 }],
    })
    await mkdir(join(b, 'lab/subjects/other'), { recursive: true })
    await target.remove('lab/subjects/s1/f.txt')
    expect((await readdir(join(b, 'lab/subjects'))).sort()).toEqual(['other'])
    await target.remove('lab/subjects/s1/f.txt') // already gone: not an error
    await rm(join(b, 'lab/subjects/other'), { recursive: true })
    await target.remove('lab/subjects/s1/f.txt')
    expect(await readdir(b)).toEqual([])
  })

  it('will not read outside the store', async () => {
    const a = await temp()
    await expect(filesLib.diskStore(a).read('../etc/passwd')).rejects.toThrow(/invalid storage path/)
  })
})
