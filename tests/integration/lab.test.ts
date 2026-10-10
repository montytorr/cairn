import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Lab (CAIRN-366, docs/lab.md) against a real database and the actual
 * route handlers: the switch, LAB-n refs and the never-reused counter, the
 * conclusion rule, todos and the home project, the detach-only delete,
 * hand-off and its 409s, search, the pulse and the activity feed.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { invalidateLabSettings } from '@/lib/api/lab-settings'
import { GET as getSettings, PUT as putSettings } from '@/app/api/v1/lab/settings/route'
import { GET as listStagesRoute, POST as createStageRoute } from '@/app/api/v1/lab/stages/route'
import { DELETE as deleteStageRoute } from '@/app/api/v1/lab/stages/[id]/route'
import { POST as createTagRoute } from '@/app/api/v1/lab/tags/route'
import { GET as listSubjectsRoute, POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import {
  DELETE as deleteSubjectRoute,
  GET as getSubjectRoute,
  PATCH as patchSubjectRoute,
} from '@/app/api/v1/subjects/[ref]/route'
import { GET as listLogRoute, POST as addLogRoute } from '@/app/api/v1/subjects/[ref]/notes/route'
import { POST as addHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/route'
import { DELETE as deleteHumanNoteRoute, PATCH as patchHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/[id]/route'
import { GET as listTodosRoute, POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { GET as mentionsRoute } from '@/app/api/v1/subjects/[ref]/mentions/route'
import { GET as showTaskRoute, PATCH as patchTaskRoute } from '@/app/api/v1/tasks/[ref]/route'
import { POST as claimRoute } from '@/app/api/v1/tasks/[ref]/claim/route'
import { POST as releaseRoute } from '@/app/api/v1/tasks/[ref]/release/route'
import { POST as noteRoute } from '@/app/api/v1/tasks/[ref]/notes/route'
import { DELETE as unlinkRoute, POST as handoffRoute } from '@/app/api/v1/tasks/[ref]/handoff/route'
import { GET as listHandoffsRoute } from '@/app/api/v1/handoffs/route'
import { POST as createProjectRoute } from '@/app/api/v1/projects/route'
import { PATCH as patchProjectRoute } from '@/app/api/v1/projects/[id]/route'
import { GET as searchRoute } from '@/app/api/v1/search/route'
import { GET as nextRoute } from '@/app/api/v1/next/route'
import { POST as checkpointRoute } from '@/app/api/v1/tasks/[ref]/checkpoint/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://cairn.example.test'
const adminId = randomUUID()
const memberId = randomUUID()
const projectId = randomUUID()
const KEY = `LB${String(Date.now()).slice(-6)}`
const AGENT = 'claude-code · lab@example.test'
const headers = { 'content-type': 'application/json', authorization: 'Bearer test' }

const as = (who: 'admin-human' | 'admin-agent' | 'member-agent') => {
  auth.actor = {
    userId: who === 'member-agent' ? memberId : adminId,
    actorType: who === 'admin-human' ? 'human' : 'agent',
    actorId: who === 'admin-human' ? 'Lab Admin' : AGENT,
    userDisplayName: who === 'member-agent' ? 'Lab Member' : 'Lab Admin',
    role: who === 'member-agent' ? 'member' : 'admin',
    rateKey: `lab-${randomUUID()}`,
    sessionId: null,
    agentName: who === 'admin-human' ? undefined : 'claude-code',
  }
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>
const call = async <P extends Record<string, string>>(
  handler: Handler<P>,
  path: string,
  params: P,
  init: { method?: string; body?: unknown } = {},
) => {
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    { params: Promise.resolve(params) },
  )
  const json = response.status === 302 ? null : await response.json()
  return { status: response.status, json, data: json?.data }
}

const setLab = async (enabled: boolean) => {
  as('admin-human')
  const result = await call(putSettings, '/lab/settings', {}, { method: 'PUT', body: { enabled } })
  as('admin-agent')
  return result
}

const pulse = async () => (await pool().query<{ p: string }>('select cairn_pulse(null) as p')).rows[0]!.p

const feed = async () =>
  (
    await pool().query<{ kind: string; ref: string; title: string; detail: string }>(
      'select kind, ref, title, detail from activity_feed($1, null, 200, null, null, null)',
      [adminId],
    )
  ).rows

const createdSubjects: string[] = []
const subject = async (body: Record<string, unknown>) => {
  const result = await call(createSubjectRoute, '/subjects', {}, { method: 'POST', body })
  if (result.data?.id) createdSubjects.push(result.data.id)
  return result
}

beforeAll(async () => {
  for (const [id, role] of [[adminId, 'admin'], [memberId, 'member']] as const) {
    await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
      id,
      `lab-${id}@example.test`,
      'not-used',
      role,
    ])
  }
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'Lab project')`, [
    projectId,
    adminId,
    KEY,
  ])
  await pool().query('update lab_settings set enabled = false, home_project_id = null')
  invalidateLabSettings()
})

afterAll(async () => {
  await pool().query('update lab_settings set enabled = false, home_project_id = null')
  await pool().query('delete from subjects where id = any($1::uuid[])', [createdSubjects])
  await pool().query(
    `delete from tasks where project_id in (select id from projects where key in ($1, 'LT', 'LABX') or owner_user_id = any($2::uuid[]))`,
    [KEY, [adminId, memberId]],
  )
  await pool().query(`delete from projects where owner_user_id = any($1::uuid[])`, [[adminId, memberId]])
  await pool().query('delete from lab_tags where name like $1', ['lab-test-%'])
  await pool().query('delete from lab_stages where name like $1', ['lab test %'])
  await pool().query('delete from task_activity_events where owner_user_id = any($1::uuid[])', [[adminId, memberId]])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[adminId, memberId]])
  await pool().end()
})

beforeEach(() => {
  as('admin-agent')
})

describe('the switch', () => {
  it('is off by default: Lab routes answer 404 lab_disabled, settings still answer', async () => {
    const list = await call(listSubjectsRoute, '/subjects', {})
    expect(list.status).toBe(404)
    expect(list.json.code).toBe('lab_disabled')
    expect((await call(listStagesRoute, '/lab/stages', {})).json.code).toBe('lab_disabled')
    expect((await call(getSubjectRoute, '/subjects/LAB-1', { ref: 'LAB-1' })).json.code).toBe('lab_disabled')

    const settings = await call(getSettings, '/lab/settings', {})
    expect(settings.status).toBe(200)
    expect(settings.data.enabled).toBe(false)
  })

  it('is toggled by a human administrator only', async () => {
    as('admin-agent')
    const byAgent = await call(putSettings, '/lab/settings', {}, { method: 'PUT', body: { enabled: true } })
    expect(byAgent.status).toBe(403)
    as('member-agent')
    expect((await call(putSettings, '/lab/settings', {}, { method: 'PUT', body: { enabled: true } })).status).toBe(403)
  })

  it('refuses to turn on while a project holds LAB, and reserves the key once it is free', async () => {
    // An instance that had a LAB project when 071 ran has no check yet.
    await pool().query('alter table projects drop constraint if exists projects_key_not_lab')
    const labProject = randomUUID()
    await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,'LAB','Old lab project')`, [
      labProject,
      adminId,
    ])

    const refused = await setLab(true)
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'conflict', project: 'LAB', project_id: labProject })

    await pool().query(`update projects set key = 'LABX' where id = $1`, [labProject])
    const enabled = await setLab(true)
    expect(enabled.status).toBe(200)
    expect(enabled.data.enabled).toBe(true)

    const { rows } = await pool().query(`select 1 from pg_constraint where conname = 'projects_key_not_lab'`)
    expect(rows).toHaveLength(1)
  })

  it('refuses LAB as a project key through the API', async () => {
    const created = await call(createProjectRoute, '/projects', {}, { method: 'POST', body: { key: 'LAB', title: 'Nope' } })
    expect(created.status).toBe(400)
    expect(created.json.field).toBe('key')
    const renamed = await call(patchProjectRoute, `/projects/${projectId}`, { id: projectId }, { method: 'PATCH', body: { key: 'LAB' } })
    expect(renamed.status).toBe(400)
  })
})

describe('subjects', () => {
  it('files into the first planned stage by default, as LAB-n', async () => {
    const created = await subject({ title: 'Evaluate pgvector for recall', body: 'Embeddings in Postgres.' })
    expect(created.status).toBe(201)
    expect(created.data.ref).toBe(`LAB-${created.data.number}`)
    expect(created.data.stage).toMatchObject({ name: 'to explore', category: 'planned' })
    expect(created.data.owner?.id).toBe(adminId)
  })

  it('resolves LAB-n, lab-n and n', async () => {
    const created = await subject({ title: 'Resolve me' })
    const n = created.data.number
    for (const ref of [`LAB-${n}`, `lab-${n}`, String(n)]) {
      const found = await call(getSubjectRoute, `/subjects/${ref}`, { ref })
      expect(found.status).toBe(200)
      expect(found.data.id).toBe(created.data.id)
    }
    expect((await call(getSubjectRoute, '/subjects/LAB-9999999', { ref: 'LAB-9999999' })).status).toBe(404)
  })

  it('points GET /tasks/LAB-n at the subject', async () => {
    const created = await subject({ title: 'Shown from a task ref' })
    const shown = await call(showTaskRoute, `/tasks/${created.data.ref}`, { ref: created.data.ref })
    expect(shown.status).toBe(404)
    expect(shown.json).toMatchObject({ subject: created.data.ref, href: `/api/v1/subjects/${created.data.ref}` })
  })

  it('never hands a deleted subject number out again', async () => {
    const first = await subject({ title: 'Filed then deleted' })
    const n = first.data.number
    const deleted = await call(deleteSubjectRoute, `/subjects/LAB-${n}?confirm=LAB-${n}`, { ref: `LAB-${n}` }, { method: 'DELETE' })
    expect(deleted.status).toBe(200)

    const next = await subject({ title: 'Filed after the delete' })
    expect(next.data.number).toBe(n + 1)
  })

  it('takes an explicit number from an admin only, and moves the counter past it', async () => {
    const top = (await pool().query<{ n: number }>('select last_number as n from subject_number_counter')).rows[0]!.n
    as('member-agent')
    expect((await subject({ title: 'Mine', number: top + 5 })).status).toBe(403)

    as('admin-agent')
    const explicit = await subject({ title: 'Imported', number: top + 5 })
    expect(explicit.data.number).toBe(top + 5)
    expect((await subject({ title: 'Imported twice', number: top + 5 })).status).toBe(409)
    expect((await subject({ title: 'After the import' })).data.number).toBe(top + 6)
  })

  it('needs a conclusion to enter a completed or dropped stage, and logs the move', async () => {
    const created = await subject({ title: 'Try Bun for the CLI' })
    const ref = created.data.ref

    const refused = await call(patchSubjectRoute, `/subjects/${ref}`, { ref }, { method: 'PATCH', body: { stage: 'rejected' } })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({ code: 'conclusion_required', stage: 'rejected', category: 'dropped' })

    const filedDone = await subject({ title: 'Straight to done', stage: 'done' })
    expect(filedDone.json.code).toBe('conclusion_required')

    const moved = await call(patchSubjectRoute, `/subjects/${ref}`, { ref }, {
      method: 'PATCH',
      body: { stage: 'rejected', conclusion: 'Node is fine; Bun breaks pg.' },
    })
    expect(moved.status).toBe(200)
    expect(moved.data.stage.name).toBe('rejected')
    expect(moved.data.concluded_at).not.toBeNull()

    const clearing = await call(patchSubjectRoute, `/subjects/${ref}`, { ref }, { method: 'PATCH', body: { conclusion: null } })
    expect(clearing.json.code).toBe('conclusion_required')

    const log = await call(listLogRoute, `/subjects/${ref}/notes`, { ref })
    expect(log.data.map((n: { kind: string; note: string }) => [n.kind, n.note])).toContainEqual(['stage', 'to explore → rejected'])

    const back = await call(patchSubjectRoute, `/subjects/${ref}`, { ref }, { method: 'PATCH', body: { stage: 'exploring' } })
    expect(back.data.concluded_at).toBeNull()
    expect(back.data.conclusion).toBe('Node is fine; Bun breaks pg.')
  })

  it('dedupes a retried log note and refuses a hand-written stage note', async () => {
    const created = await subject({ title: 'Log dedupe' })
    const ref = created.data.ref
    const first = await call(addLogRoute, `/subjects/${ref}/notes`, { ref }, { method: 'POST', body: { kind: 'finding', note: 'It works.' } })
    expect(first.status).toBe(201)
    const again = await call(addLogRoute, `/subjects/${ref}/notes`, { ref }, { method: 'POST', body: { kind: 'finding', note: 'It works.' } })
    expect(again.status).toBe(200)
    expect(again.data.duplicate).toBe(true)
    const stage = await call(addLogRoute, `/subjects/${ref}/notes`, { ref }, { method: 'POST', body: { kind: 'stage', note: 'a → b' } })
    expect(stage.status).toBe(400)
  })

  it('lets only the author edit a person\'s note, and the author or an admin delete it', async () => {
    const created = await subject({ title: 'Human notes' })
    const ref = created.data.ref
    as('member-agent')
    const note = await call(addHumanNoteRoute, `/subjects/${ref}/human-notes`, { ref }, { method: 'POST', body: { body: 'Asked Marc.' } })
    expect(note.status).toBe(201)
    const id = note.data.id

    as('admin-agent')
    const edit = await call(patchHumanNoteRoute, `/subjects/${ref}/human-notes/${id}`, { ref, id }, { method: 'PATCH', body: { body: 'x' } })
    expect(edit.status).toBe(403)
    as('member-agent')
    expect((await call(patchHumanNoteRoute, `/subjects/${ref}/human-notes/${id}`, { ref, id }, { method: 'PATCH', body: { body: 'Asked Marc: per seat.' } })).data.body).toBe('Asked Marc: per seat.')
    as('admin-agent')
    expect((await call(deleteHumanNoteRoute, `/subjects/${ref}/human-notes/${id}`, { ref, id }, { method: 'DELETE' })).status).toBe(200)
  })

  it('filters the board by tag, category and project, and refuses unknown names', async () => {
    as('admin-agent')
    const tag = await call(createTagRoute, '/lab/tags', {}, { method: 'POST', body: { name: 'Lab-Test-Search', color: '#AABBCC' } })
    expect(tag.data).toMatchObject({ name: 'lab-test-search', color: '#aabbcc' })

    const tagged = await subject({ title: 'Tagged idea', tags: ['lab-test-search'], project: KEY })
    expect(tagged.data.project).toMatchObject({ key: KEY })

    const byTag = await call(listSubjectsRoute, '/subjects?tag=lab-test-search', {})
    expect(byTag.data.map((s: { id: string }) => s.id)).toEqual([tagged.data.id])
    const ideas = await call(listSubjectsRoute, `/subjects?category=planned&project=${KEY}`, {})
    expect(ideas.data.map((s: { id: string }) => s.id)).toContain(tagged.data.id)

    const unknown = await call(listSubjectsRoute, '/subjects?tag=nope-not-a-tag', {})
    expect(unknown.status).toBe(400)
    expect((await subject({ title: 'Bad tag', tags: ['nope-not-a-tag'] })).status).toBe(400)
  })

  it('refuses to delete a stage that holds subjects', async () => {
    const stage = await call(createStageRoute, '/lab/stages', {}, { method: 'POST', body: { name: 'lab test lane', category: 'active' } })
    expect(stage.status).toBe(201)
    await subject({ title: 'In the test lane', stage: 'lab test lane' })
    const refused = await call(deleteStageRoute, `/lab/stages/${stage.data.id}`, { id: stage.data.id }, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'stage_in_use', subjects: 1 })

    as('member-agent')
    expect((await call(createStageRoute, '/lab/stages', {}, { method: 'POST', body: { name: 'lab test nope', category: 'active' } })).status).toBe(403)
  })
})

describe('todos', () => {
  it('files a todo of a subject without a project in the LT home project, and of one with a project there', async () => {
    const loose = await subject({ title: 'No project' })
    const todo = await call(addTodoRoute, `/subjects/${loose.data.ref}/todos`, { ref: loose.data.ref }, { method: 'POST', body: { title: 'Read the docs' } })
    expect(todo.status).toBe(201)
    expect(todo.data.ref).toMatch(/^LT-\d+$/)
    expect(todo.data.status).toBe('todo')
    expect(todo.data.subject).toEqual({ ref: loose.data.ref, title: 'No project' })
    expect(todo.data).not.toHaveProperty('subject_id')

    const settings = await call(getSettings, '/lab/settings', {})
    expect(settings.data.home_project.key).toBe('LT')

    const homed = await subject({ title: 'With a project', project: KEY })
    const there = await call(addTodoRoute, `/subjects/${homed.data.ref}/todos`, { ref: homed.data.ref }, { method: 'POST', body: { title: 'Build it' } })
    expect(there.data.ref).toMatch(new RegExp(`^${KEY}-\\d+$`))

    const listed = await call(listTodosRoute, `/subjects/${homed.data.ref}/todos`, { ref: homed.data.ref })
    expect(listed.data.map((t: { ref: string }) => t.ref)).toEqual([there.data.ref])

    const shown = await call(showTaskRoute, `/tasks/${there.data.ref}`, { ref: there.data.ref })
    expect(shown.data.subject).toEqual({ ref: homed.data.ref, title: 'With a project' })
    expect(shown.data.handoff).toBeNull()
    expect(Object.keys(shown.data).filter((k) => k.startsWith('handoff_'))).toEqual([])
  })

  it('refuses to delete a subject with todos unless they are detached, and never deletes them', async () => {
    const parent = await subject({ title: 'Doomed subject', project: KEY })
    const ref = parent.data.ref
    const todo = await call(addTodoRoute, `/subjects/${ref}/todos`, { ref }, { method: 'POST', body: { title: 'Survives' } })
    await call(patchTaskRoute, `/tasks/${todo.data.ref}`, { ref: todo.data.ref }, {
      method: 'PATCH',
      body: { status: 'done', resolution: 'Did it.' },
    })

    expect((await call(deleteSubjectRoute, `/subjects/${ref}`, { ref }, { method: 'DELETE' })).status).toBe(400)
    const refused = await call(deleteSubjectRoute, `/subjects/${ref}?confirm=${ref}`, { ref }, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'subject_has_todos', todos: 1, open: 0 })

    as('member-agent')
    expect((await call(deleteSubjectRoute, `/subjects/${ref}?confirm=${ref}&todos=detach`, { ref }, { method: 'DELETE' })).status).toBe(403)

    as('admin-agent')
    const deleted = await call(deleteSubjectRoute, `/subjects/${ref}?confirm=${ref}&todos=detach`, { ref }, { method: 'DELETE' })
    expect(deleted.data).toMatchObject({ deleted: true, todos_detached: 1 })

    const kept = await call(showTaskRoute, `/tasks/${todo.data.ref}`, { ref: todo.data.ref })
    expect(kept.status).toBe(200)
    expect(kept.data.status).toBe('done')
    expect(kept.data.subject).toBeNull()
    const { rows } = await pool().query('select note from task_notes where task_id = $1', [todo.data.id])
    expect(rows.map((r) => r.note)).toContain(`Was a todo of ${ref} (Doomed subject), which was deleted.`)
  })

  it('links and unlinks an existing task through PATCH subject', async () => {
    const target = await subject({ title: 'Adopts a task' })
    const { rows } = await pool().query<{ number: number }>(
      `insert into tasks (project_id, title, actor_type, actor_id, status) values ($1, 'Loose task', 'agent', $2, 'todo') returning number`,
      [projectId, AGENT],
    )
    const taskRef = `${KEY}-${rows[0]!.number}`
    const linked = await call(patchTaskRoute, `/tasks/${taskRef}`, { ref: taskRef }, { method: 'PATCH', body: { subject: target.data.ref } })
    expect(linked.data.subject).toEqual({ ref: target.data.ref, title: 'Adopts a task' })
    const unlinked = await call(patchTaskRoute, `/tasks/${taskRef}`, { ref: taskRef }, { method: 'PATCH', body: { subject: null } })
    expect(unlinked.data.subject).toBeNull()
  })
})

describe('hand-off', () => {
  let ref = ''
  let subjectRef = ''

  beforeAll(async () => {
    as('admin-agent')
    const parent = await subject({ title: 'Handed-off work', project: KEY })
    subjectRef = parent.data.ref
    const todo = await call(addTodoRoute, `/subjects/${subjectRef}/todos`, { ref: subjectRef }, { method: 'POST', body: { title: 'Goes elsewhere' } })
    ref = todo.data.ref
    await call(claimRoute, `/tasks/${ref}/claim`, { ref }, { method: 'POST', body: {} })
  })

  it('needs an https url naming the instance for a cairn hand-off', async () => {
    const bare = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, { method: 'POST', body: { tracker: 'cairn', ref: 'KDP-41' } })
    expect(bare.status).toBe(400)
    expect(bare.json.field).toBe('url')
    const plain = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, {
      method: 'POST',
      body: { tracker: 'cairn', ref: 'KDP-41', url: 'http://tasks.example.com/projects/KDP/tasks/41' },
    })
    expect(plain.status).toBe(400)
    // The floor beneath the route.
    await expect(
      pool().query(`update tasks set handoff_tracker = 'cairn', handoff_ref = 'KDP-41' where project_id = $1`, [projectId]),
    ).rejects.toThrow(/tasks_handoff_cairn_url_check/)
  })

  it('links, releases the claim and writes the log', async () => {
    const linked = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, {
      method: 'POST',
      body: { tracker: 'cairn', ref: 'KDP-41', url: 'https://tasks.example.com/projects/KDP/tasks/41' },
    })
    expect(linked.status).toBe(200)
    expect(linked.data).toMatchObject({ subject: subjectRef, status: 'todo', closed: false })
    expect(linked.data.handoff).toMatchObject({ tracker: 'cairn', ref: 'KDP-41' })

    const shown = await call(showTaskRoute, `/tasks/${ref}`, { ref })
    expect(shown.data.claimed_by).toBeNull()
    const log = await call(listLogRoute, `/subjects/${subjectRef}/notes`, { ref: subjectRef })
    expect(log.data.map((n: { note: string }) => n.note)).toContain(`${ref} handed off to cairn as KDP-41`)

    const open = await call(listHandoffsRoute, '/handoffs?tracker=cairn', {})
    expect(open.data.map((h: { ref: string }) => h.ref)).toContain(ref)
  })

  it('refuses claim, release and status changes with 409 handed_off, but not edits or notes', async () => {
    const claim = await call(claimRoute, `/tasks/${ref}/claim`, { ref }, { method: 'POST', body: {} })
    expect(claim.status).toBe(409)
    expect(claim.json).toMatchObject({ code: 'handed_off', tracker: 'cairn', handoffRef: 'KDP-41' })
    expect((await call(releaseRoute, `/tasks/${ref}/release`, { ref }, { method: 'POST', body: {} })).json.code).toBe('handed_off')
    for (const body of [{ status: 'doing' }, { status: 'done', resolution: 'x' }, { status: 'cancelled', resolution: 'x' }]) {
      expect((await call(patchTaskRoute, `/tasks/${ref}`, { ref }, { method: 'PATCH', body })).json.code).toBe('handed_off')
    }
    expect((await call(patchTaskRoute, `/tasks/${ref}`, { ref }, { method: 'PATCH', body: { title: 'Renamed while away' } })).status).toBe(200)
    expect((await call(noteRoute, `/tasks/${ref}/notes`, { ref }, { method: 'POST', body: { kind: 'note', note: 'still notable' } })).status).toBe(201)
  })

  it('is not offered by next while the hand-off is open', async () => {
    const offered = async () => {
      const result = await call(nextRoute, `/next?project=${KEY}&limit=20`, {})
      return [result.data.pick, ...result.data.then].filter(Boolean).map((c: { ref: string }) => c.ref)
    }
    expect(await offered()).not.toContain(ref)
    // A task of the same project with no hand-off still is.
    const { rows } = await pool().query<{ number: number }>(
      `insert into tasks (project_id, title, actor_type, actor_id, status, assignee_user_id)
       values ($1, 'Offerable', 'agent', $2, 'todo', $3) returning number`,
      [projectId, AGENT, adminId],
    )
    expect(await offered()).toContain(`${KEY}-${rows[0]!.number}`)
  })

  it('is refused by the database claim paths too, not only by the route', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `select t.id from tasks t join projects p on p.id = t.project_id where p.key || '-' || t.number = $1`,
      [ref],
    )
    const id = rows[0]!.id
    const claimed = await pool().query(
      `select claim_task_atomic($1, $2, 'agent', $3, $3, now() - interval '1 hour', true) as row`,
      [id, adminId, AGENT],
    )
    expect(claimed.rows[0].row).toBeNull()
    const checkpointed = await pool().query(
      `select checkpoint_task_atomic($1, $2, 'agent', $3, 'cp', null, gen_random_uuid(), now()) as result`,
      [id, adminId, AGENT],
    )
    expect(checkpointed.rows[0].result).toEqual({ code: 'handed_off' })
    const viaRoute = await call(checkpointRoute, `/tasks/${ref}/checkpoint`, { ref }, { method: 'POST', body: { summary: 'cp' } })
    expect(viaRoute.json.code).toBe('handed_off')
  })

  it('refuses a secret in the resolution, as PATCH does', async () => {
    // Assembled at run time, as in secrets.test.ts, so this file holds nothing
    // a repository scanner reads as a leaked key.
    const fakeKey = ['sk', 'live', ''].join('_') + Array.from({ length: 24 }, (_, i) => 'aB3dE5gH7jK9'[i % 12]).join('')
    const leaked = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, {
      method: 'POST',
      body: { tracker: 'cairn', ref: 'KDP-41', status: 'doing', resolution: `key ${fakeKey}` },
    })
    expect(leaked.status).toBe(400)
    expect(leaked.json.code).toBe('secret_detected')
  })

  it('syncs a status without a url, and closes once when the tracker ends it', async () => {
    const sync = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, { method: 'POST', body: { tracker: 'cairn', ref: 'KDP-41', status: 'doing' } })
    expect(sync.status).toBe(200)
    expect(sync.data.handoff).toMatchObject({ status: 'doing', url: 'https://tasks.example.com/projects/KDP/tasks/41' })

    const ended = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, {
      method: 'POST',
      body: { tracker: 'cairn', ref: 'KDP-41', status: 'Closed', resolution: 'Shipped in KDP.', resolutionKind: 'fixed' },
    })
    expect(ended.data).toMatchObject({ closed: true, status: 'done' })
    const shown = await call(showTaskRoute, `/tasks/${ref}`, { ref })
    expect(shown.data).toMatchObject({ status: 'done', resolution: 'Closed in cairn as KDP-41: Shipped in KDP.', resolution_kind: 'fixed' })

    const again = await call(handoffRoute, `/tasks/${ref}/handoff`, { ref }, {
      method: 'POST',
      body: { tracker: 'cairn', ref: 'KDP-41', status: 'done', resolution: 'Shipped in KDP, revised.' },
    })
    expect(again.data).toMatchObject({ closed: false, noted: false })
    const log = await call(listLogRoute, `/subjects/${subjectRef}/notes?kind=finding`, { ref: subjectRef })
    expect(log.data.filter((n: { note: string }) => n.note.startsWith('KDP-41 done'))).toHaveLength(1)

    // Ended: an ordinary closed task again.
    expect((await call(patchTaskRoute, `/tasks/${ref}`, { ref }, { method: 'PATCH', body: { status: 'todo' } })).status).toBe(200)
  })

  it('takes a hand-off back', async () => {
    const taken = await call(unlinkRoute, `/tasks/${ref}/handoff`, { ref }, { method: 'DELETE' })
    expect(taken.status).toBe(200)
    expect(taken.data.handoff).toBeNull()
    expect((await call(unlinkRoute, `/tasks/${ref}/handoff`, { ref }, { method: 'DELETE' })).status).toBe(409)
  })

  it('records project hand-off defaults as a pair', async () => {
    const half = await call(patchProjectRoute, `/projects/${projectId}`, { id: projectId }, { method: 'PATCH', body: { handoffTracker: 'github' } })
    expect(half.status).toBe(400)
    const both = await call(patchProjectRoute, `/projects/${projectId}`, { id: projectId }, {
      method: 'PATCH',
      body: { handoffTracker: 'github', handoffTarget: 'montytorr/kdp' },
    })
    expect(both.data).toMatchObject({ handoff_tracker: 'github', handoff_target: 'montytorr/kdp' })
  })
})

describe('edges', () => {
  it('answers 404, not 500, for a task ref that is not valid percent-encoding', async () => {
    const shown = await call(showTaskRoute, '/tasks/100%', { ref: '100%' })
    expect(shown.status).toBe(404)
  })

  it('takes two settings writes at once', async () => {
    as('admin-human')
    const [a, b] = await Promise.all([
      call(putSettings, '/lab/settings', {}, { method: 'PUT', body: { enabled: true } }),
      call(putSettings, '/lab/settings', {}, { method: 'PUT', body: { enabled: true } }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.data.warning).toBeUndefined()
    expect(b.data.warning).toBeUndefined()
    as('admin-agent')
  })

  it('stores tag names lower-cased whatever case they arrive in', async () => {
    const tag = await call(createTagRoute, '/lab/tags', {}, { method: 'POST', body: { name: '  Lab-Test-ÉCLAIR  ' } })
    expect(tag.status).toBe(201)
    expect(tag.data.name).toBe('lab-test-éclair')
    expect((await subject({ title: 'Tagged in capitals', tags: ['LAB-TEST-ÉCLAIR'] })).status).toBe(201)
  })

  it('pins a LAB-n hit in a project-scoped search only when the subject is in that project', async () => {
    const inside = await subject({ title: 'Scoped pin inside', project: KEY })
    const outside = await subject({ title: 'Scoped pin outside' })
    const scoped = async (ref: string) => (await call(searchRoute, `/search?q=${ref}&project=${KEY}`, {})).data.results
    expect((await scoped(inside.data.ref))[0]).toMatchObject({ kind: 'subject', ref: inside.data.ref })
    expect((await scoped(outside.data.ref)).map((r: { ref: string }) => r.ref)).not.toContain(outside.data.ref)
  })

  it('refuses a todo with a clear conflict when the home project is archived', async () => {
    const loose = await subject({ title: 'Homeless' })
    const home = (await call(getSettings, '/lab/settings', {})).data.home_project
    expect(home?.key).toBe('LT')
    await pool().query(`update projects set status = 'archived' where id = $1`, [home.id])
    const refused = await call(addTodoRoute, `/subjects/${loose.data.ref}/todos`, { ref: loose.data.ref }, { method: 'POST', body: { title: 'x' } })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/home project for todos, LT, is archived/)
    await pool().query(`update projects set status = 'active' where id = $1`, [home.id])
  })

  it('keeps subject data out of a hand-off while the Lab is off', async () => {
    const parent = await subject({ title: 'Quiet while off', project: KEY })
    const todo = await call(addTodoRoute, `/subjects/${parent.data.ref}/todos`, { ref: parent.data.ref }, { method: 'POST', body: { title: 'Leaves while off' } })
    const taskRef = todo.data.ref

    await setLab(false)
    const linked = await call(handoffRoute, `/tasks/${taskRef}/handoff`, { ref: taskRef }, {
      method: 'POST',
      body: { tracker: 'github', ref: 'montytorr/kdp#7', url: 'https://github.com/montytorr/kdp/issues/7' },
    })
    expect(linked.data).toMatchObject({ subject: null, noted: false })
    const listed = await call(listHandoffsRoute, '/handoffs?tracker=github', {})
    expect(listed.data.find((h: { ref: string }) => h.ref === taskRef)).toMatchObject({ subject: null })
    const taken = await call(unlinkRoute, `/tasks/${taskRef}/handoff`, { ref: taskRef }, { method: 'DELETE' })
    expect(taken.data).not.toHaveProperty('subject')
    const { rows: notes } = await pool().query(`select 1 from subject_notes where subject_id = $1 and kind = 'handoff'`, [parent.data.id])
    expect(notes).toHaveLength(0)
    const { rows: events } = await pool().query(
      `select subject_id from task_activity_events where task_id = $1 and event in ('handed_off', 'handoff_taken_back')`,
      [todo.data.id],
    )
    expect(events.map((e) => e.subject_id)).toEqual([null, null])
    await setLab(true)
  })
})

describe('mentions, search, pulse and activity', () => {
  it('records LAB-n written in a task as a mention of the subject', async () => {
    const target = await subject({ title: 'Mentioned subject' })
    const { rows } = await pool().query<{ id: string; number: number }>(
      `insert into tasks (project_id, title, description, actor_type, actor_id, status)
       values ($1, 'Mentions', $2, 'agent', $3, 'todo') returning id, number`,
      [projectId, `Same idea as ${target.data.ref}, see there.`, AGENT],
    )
    const mentions = await call(mentionsRoute, `/subjects/${target.data.ref}/mentions`, { ref: target.data.ref })
    expect(mentions.data.total).toBe(1)
    expect(mentions.data.items[0]).toMatchObject({ ref: `${KEY}-${rows[0]!.number}`, source: 'description' })
    expect(mentions.data.items[0].excerpt).toContain(target.data.ref)
    const tm = await pool().query('select 1 from task_mentions where source_task_id = $1', [rows[0]!.id])
    expect(tm.rows).toHaveLength(0)
  })

  it('finds subjects by text and resolves a LAB-n query first', async () => {
    const created = await subject({ title: 'Quokka telemetry pipeline', body: 'Zanzibar ingestion' })
    await call(patchSubjectRoute, `/subjects/${created.data.ref}`, { ref: created.data.ref }, {
      method: 'PATCH',
      body: { stage: 'done', conclusion: 'Quokka works with batching.' },
    })

    const byText = await call(searchRoute, '/search?q=quokka%20telemetry', {})
    expect(byText.data.results.find((r: { ref: string }) => r.ref === created.data.ref)).toMatchObject({
      kind: 'subject',
      status: 'done',
      resolved: true,
    })

    const byRef = await call(searchRoute, `/search?q=${created.data.ref}`, {})
    expect(byRef.data.results[0]).toMatchObject({ kind: 'subject', ref: created.data.ref })

    const onlySubjects = await call(searchRoute, '/search?q=zanzibar&kinds=subject', {})
    expect(onlySubjects.data.results.map((r: { kind: string }) => r.kind)).toEqual(['subject'])
  })

  it('moves the pulse on a subject change, a log note and a tag', async () => {
    const created = await subject({ title: 'Pulse subject' })
    const before = await pulse()
    await call(addLogRoute, `/subjects/${created.data.ref}/notes`, { ref: created.data.ref }, { method: 'POST', body: { note: 'tick' } })
    const afterNote = await pulse()
    expect(afterNote).not.toBe(before)
    await call(patchSubjectRoute, `/subjects/${created.data.ref}`, { ref: created.data.ref }, { method: 'PATCH', body: { title: 'Pulse subject, renamed' } })
    expect(await pulse()).not.toBe(afterNote)
  })

  it('shows subject events and the log in the feed while the Lab is on, and hides them when off', async () => {
    const created = await subject({ title: 'Feed subject' })
    const ref = created.data.ref
    await call(patchSubjectRoute, `/subjects/${ref}`, { ref }, { method: 'PATCH', body: { stage: 'exploring' } })
    await call(addLogRoute, `/subjects/${ref}/notes`, { ref }, { method: 'POST', body: { kind: 'decision', note: 'Use it.' } })

    const rows = (await feed()).filter((r) => r.ref === ref)
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'event', detail: 'subject_created', title: 'Feed subject' }))
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'event', detail: 'to explore → exploring' }))
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'note', detail: 'decision', title: 'Use it.' }))

    await setLab(false)
    expect((await feed()).filter((r) => r.ref === ref)).toEqual([])
    const search = await call(searchRoute, '/search?q=feed%20subject', {})
    expect(search.data.results.filter((r: { kind: string }) => r.kind === 'subject')).toEqual([])
    const shown = await call(showTaskRoute, `/tasks/${ref}`, { ref })
    expect(shown.json).not.toHaveProperty('subject')
    await setLab(true)
  })
})
