/**
 * A made-up Croft database, shaped like the real one (CAIRN-369): 19 subjects,
 * S-1 to S-20 with S-15 deleted; 9 stages, 4 tags, 2 lab projects, 2 users; 63
 * todos in the project `T`, 41 handed off to cairn; 0 attachments and 2 human
 * notes; every subject visible to the lab.
 *
 * `croftFixture()` returns the rows as the importer's reader would return them
 * (timestamps as the text Postgres sends). `seedCroft(client, fixture)` inserts
 * them into a database built from schema.sql, so one value feeds the unit tests
 * and the integration test, and the reader's output can be compared to it.
 *
 * Deterministic: no clock, no random ids.
 */
import { createHash } from 'node:crypto'

const uid = (kind, n) => `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const hash = (kind, note) => createHash('sha256').update(`${kind}\n${note}`).digest('hex').slice(0, 32)

/** The text Postgres prints for a timestamptz in a UTC session. Microseconds on purpose. */
const at = (day, minute = 0, micros = 0) => {
  const d = new Date(Date.UTC(2026, 5, 1 + day, 9, minute, (micros % 60) | 0))
  const stamp = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  // Postgres prints the fraction without trailing zeros.
  const fraction = String(123456 + micros * 7).slice(-6).replace(/0+$/, '')
  return `${stamp}${fraction ? `.${fraction}` : ''}+00`
}

export const CAL = uid(1, 1)
export const MAEL = uid(1, 2)
export const CAL_EMAIL = 'cal@example.test'
export const MAEL_EMAIL = 'mael@example.test'
export const AGENT = 'claude-code · cal@example.test'

export const STAGES = [
  ['to explore', 'planned', '#8a8792'],
  ['exploring', 'active', '#6b7fa6'],
  ['done', 'completed', '#5f8a63'],
  ['rejected', 'dropped', '#a0685f'],
  ['to implement', 'planned', '#8f8a74'],
  ['implementing', 'active', '#a88a4e'],
  ['internal testing', 'active', '#86709e'],
  ['ready for rollout', 'active', '#4f8c86'],
  ['rolled out', 'completed', '#4e7f5a'],
]

const TOPICS = [
  'Evaluate pgvector for recall',
  'Local-first sync for the board',
  'Image models for coloring pages',
  'Print-on-demand mug margins',
  'Voice notes into subjects',
  'Customer.io broadcast API',
  'Cheaper embeddings',
  'A second look at tiptap tables',
  'Agent key rotation',
  'Search eval harness',
  'Puzzle generators',
  'Sudoku variants for KDP',
  'Webhooks for hand-off',
  'Calendar view',
  'Kindle low-content niches',
  'Offline CLI cache',
  'Scale Amazon KDP publishing: coloring, puzzle and low-content',
  'AI image products on Amazon: posters, mugs, t-shirts',
  'KDP cerebral games: logic puzzles and brain-game books',
  'Backups to object storage',
]

const SUBJECT_STAGE = new Map([
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 20].map((n) => [n, 'to explore']),
  ...[14, 16, 17, 18, 19].map((n) => [n, 'implementing']),
  ...[11, 12].map((n) => [n, 'internal testing']),
])
const SUBJECT_PROJECT = new Map([
  [1, 'Trig'],
  [2, 'Trig'],
  [3, 'Trig'],
  [4, 'Croft'],
  [5, 'Croft'],
])
const SUBJECT_NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => n !== 15)

/** [subject number, todo count]: the rest of T-1..T-63 have no subject. */
const TODO_SUBJECTS = [
  [17, 4],
  [18, 5],
  [19, 3],
  [1, 4],
  [4, 4],
  [2, 4],
  [14, 4],
  [16, 2],
  [3, 10],
  [11, 5],
  [12, 5],
]

const STATUSES = ['backlog', 'todo', 'doing', 'in-review', 'done', 'cancelled']
const PRIORITIES = ['urgent', 'high', 'medium', 'low']
const TYPES = ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs']

export const croftFixture = ({ attachments = false } = {}) => {
  const f = {
    problems: [],
    migrations: ['081_clean_fork.sql'],
    users: [
      { id: CAL, email: CAL_EMAIL, encrypted_password: '$2b$10$calcalcalcalcalcalcalcuQ0M9Jt0q1Zr3v5W7y9A1c3E5g7I9k', banned_until: null, deleted_at: null, created_at: at(0), updated_at: at(40, 3), role: 'admin', auth_epoch: '2', session_epoch: '5' },
      { id: MAEL, email: MAEL_EMAIL, encrypted_password: '$2b$10$maelmaelmaelmaelmaelmeuQ0M9Jt0q1Zr3v5W7y9A1c3E5g7I9k', banned_until: null, deleted_at: null, created_at: at(2), updated_at: at(2), role: 'member', auth_epoch: '0', session_epoch: '0' },
    ],
    profiles: [
      { id: CAL, display_name: 'Cal', avatar_url: null, created_at: at(0), updated_at: at(0) },
      { id: MAEL, display_name: 'Mael', avatar_url: 'https://example.test/m.png', created_at: at(2), updated_at: at(9) },
    ],
    stages: STAGES.map(([name, category, color], i) => ({
      id: uid(2, i + 1),
      name,
      category,
      color,
      position: i,
      created_at: at(0, i),
      updated_at: at(0, i),
    })),
    tags: ['search', 'infra', 'ai', 'growth'].map((name, i) => ({
      id: uid(3, i + 1),
      name,
      color: ['#6b7fa6', '#8a8792', '#86709e', '#4f8c86'][i],
      position: i,
      created_at: at(1, i),
      updated_at: at(1, i),
    })),
    labProjects: [
      { id: uid(4, 1), name: 'Trig', color: '#6b7fa6', handoff_target: 'TRIG', position: 0, created_at: at(3), updated_at: at(3), archived_at: null, handoff_tracker: 'cairn' },
      { id: uid(4, 2), name: 'Croft', color: '#a88a4e', handoff_target: 'CROFT', position: 1, created_at: at(3, 1), updated_at: at(20), archived_at: null, handoff_tracker: 'cairn' },
    ],
    subjects: [],
    subjectTags: [],
    subjectNotes: [],
    subjectHumanNotes: [],
    subjectAttachments: [],
    counter: 20,
    projects: [
      { id: uid(6, 1), owner_user_id: CAL, key: 'T', title: 'Lab todos', description: null, status: 'active', position: 0, task_counter: 63, created_at: at(0), updated_at: at(60), external_ref: null, external_url: null },
    ],
    tasks: [],
    taskNotes: [],
    taskComments: [],
    taskEvents: [],
    taskAttachments: [],
    leftBehind: [
      { table: 'api_keys', count: 3, why: 'agent keys are not copied: people pair again' },
      { table: 'app_sessions', count: 4, why: 'sessions are not copied: people sign in again' },
    ],
  }

  const stageId = (name) => f.stages.find((s) => s.name === name).id
  const labProjectId = (name) => f.labProjects.find((p) => p.name === name).id

  for (const n of SUBJECT_NUMBERS) {
    const projectName = SUBJECT_PROJECT.get(n)
    const archived = n === 6 || n === 7
    f.subjects.push({
      id: uid(5, n),
      number: n,
      title: TOPICS[n - 1],
      body: n % 2 ? `## ${TOPICS[n - 1]}\n\nWhy it matters, and a link to S-${n === 1 ? 2 : 1} and T-${n}.` : null,
      stage_id: stageId(SUBJECT_STAGE.get(n)),
      owner_user_id: n % 3 === 0 ? null : n % 2 ? CAL : MAEL,
      conclusion: n === 13 ? 'Parked: not worth it at our volume.' : null,
      concluded_at: null,
      position: n,
      actor_type: n % 4 === 0 ? 'agent' : 'human',
      actor_id: n % 4 === 0 ? AGENT : CAL_EMAIL,
      created_at: at(5 + n, n, n),
      updated_at: at(30 + n, n, n + 1),
      archived_at: archived ? at(50 + n) : null,
      project_id: projectName ? labProjectId(projectName) : null,
      visibility: 'lab',
    })
    if (n % 2 === 0) f.subjectTags.push({ subject_id: uid(5, n), tag_id: uid(3, (n % 4) + 1) })
    if (n % 5 === 0) f.subjectTags.push({ subject_id: uid(5, n), tag_id: uid(3, ((n + 1) % 4) + 1) })

    const note = (i, kind, text, extra = {}) =>
      f.subjectNotes.push({
        id: uid(8, n * 100 + i),
        subject_id: uid(5, n),
        kind,
        note: text,
        actor_type: 'agent',
        actor_id: AGENT,
        user_id: null,
        content_hash: kind === 'stage' ? `${hash(kind, text)}`.replace(/.$/, String(i)) : hash(kind, text),
        created_at: at(6 + n, i, i),
        ...extra,
      })
    note(1, 'note', `Read the docs for ${TOPICS[n - 1]}.`)
    if (n % 3 === 0) note(2, 'finding', `Works with the default settings. See T-${n}.`, { user_id: CAL, actor_type: 'human', actor_id: CAL_EMAIL })
    if (n % 4 === 0) note(3, 'decision', 'Go ahead with a small proof of concept.')
    if (n % 5 === 0) note(4, 'attempt', 'Tried the obvious thing; it timed out.')
    if (n % 7 === 0) note(5, 'handoff', `T-${n} handed off to cairn as KDP-${n}`)
    if (SUBJECT_STAGE.get(n) !== 'to explore') note(6, 'stage', 'to explore → exploring')
    if (n === 2 || n === 9 || n === 13) note(7, 'visibility', 'Visibility: lab (was private).')
  }
  // Refs that must survive --rewrite-refs: code, links, URLs and a lookalike.
  const s3 = f.subjects.find((s) => s.number === 3)
  s3.body +=
    '\n\nThe old `S-1` stays in code, [S-2](https://croft.montytorr.com/subjects/2) and ' +
    'https://croft.montytorr.com/subjects/S-4 stay in links.\n\n```\nT-3 in a fence\n```\n\nBuy T-shirts for S-1.'
  f.subjectNotes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))

  f.subjectHumanNotes.push(
    { id: uid(9, 1), subject_id: uid(5, 3), body: 'Mael: this one needs a real dataset.', user_id: MAEL, actor_type: 'human', actor_id: MAEL_EMAIL, created_at: at(40, 1, 3), updated_at: at(41, 2, 4) },
    { id: uid(9, 2), subject_id: uid(5, 17), body: 'Cal: the margin is thinner than it looks.', user_id: CAL, actor_type: 'human', actor_id: CAL_EMAIL, created_at: at(44, 5, 6), updated_at: at(44, 5, 6) },
  )

  // --- todos -----------------------------------------------------------------
  const subjectOfTodo = []
  for (const [subject, count] of TODO_SUBJECTS) for (let i = 0; i < count; i += 1) subjectOfTodo.push(subject)
  while (subjectOfTodo.length < 63) subjectOfTodo.push(null)

  const handoffKey = (n, subject) => (subject >= 17 && subject <= 19 ? 'KDP' : subject === 4 ? 'CROFT' : 'TRIG')
  for (let n = 1; n <= 63; n += 1) {
    const subject = subjectOfTodo[n - 1]
    const handed = n <= 42 && n !== 9
    const status = n === 9 ? 'done' : STATUSES[(n * 5) % 6]
    // T-4 and T-5 are handed off and open (the tracker owns their status); T-50 is not.
    const claimed = n === 4 || n === 5 || n === 50
    const key = handed ? handoffKey(n, subject) : null
    const ended = handed && (n % 7 === 0 || n % 11 === 0)
    const resolved = status === 'done' || status === 'cancelled' || ended
    const handoffStatus = !handed ? null : ended ? (n % 11 === 0 ? 'cancelled' : 'done') : n % 3 === 0 ? 'doing' : null
    const taskStatus = ended ? (handoffStatus === 'done' ? 'done' : 'cancelled') : claimed ? 'doing' : status
    const finished = taskStatus === 'done' || taskStatus === 'cancelled'
    f.tasks.push({
      id: uid(7, n),
      project_id: uid(6, 1),
      number: n,
      title: `Todo ${n}: ${TOPICS[(n + 3) % 20]}`,
      description: n % 3 ? `Do the thing for S-${subject ?? 1}. Blocked by T-${Math.max(1, n - 1)}.` : null,
      type: TYPES[n % 6],
      status: taskStatus,
      priority: PRIORITIES[n % 4],
      labels: n % 5 === 0 ? ['kdp', 'review'] : [],
      due_date: n === 9 ? '2026-09-30' : null,
      position: n,
      actor_type: n % 4 === 0 ? 'agent' : 'human',
      actor_id: n % 4 === 0 ? AGENT : CAL_EMAIL,
      claimed_by: claimed ? AGENT : null,
      claimed_at: claimed ? at(55, n) : null,
      heartbeat_at: claimed ? at(55, n + 1) : null,
      attempt: claimed ? 1 : 0,
      checkpoint_summary: claimed ? 'Half way through the first pass.' : null,
      checkpoint_payload: claimed ? { step: 2, of: 4 } : null,
      checkpoint_at: claimed ? at(55, n + 2) : null,
      blocked_reason: null,
      blocked_at: null,
      resolution: finished ? `Closed: ${finished ? 'checked and done' : ''}.` : null,
      resolution_kind: finished ? (taskStatus === 'cancelled' ? 'wont-fix' : n === 9 ? 'duplicate' : 'fixed') : null,
      resolved_at: finished && resolved ? at(58, n) : null,
      resolved_by: finished && resolved ? CAL_EMAIL : null,
      memory_session_id: null,
      observation_ids: null,
      created_at: at(10 + n, n, n),
      updated_at: at(45 + (n % 9), n, n + 2),
      external_ref: n === 60 ? 'https://example.test/issue/60' : null,
      external_url: null,
      comments_text: null,
      duplicate_of: n === 9 ? uid(7, 8) : null,
      parent_id: n === 2 ? uid(7, 4) : n === 7 || n === 8 ? uid(7, 6) : null,
      ownership_version: String(claimed ? 1 : 0),
      checkpoint_version: String(claimed ? 1 : 0),
      checkpoint_mutation_id: null,
      claimed_session: claimed ? `session-${n}` : null,
      assignee_user_id: n % 2 ? CAL : MAEL,
      subject_id: subject ? uid(5, subject) : null,
      handoff_ref: handed ? `${key}-${n % 2 ? 100 + n : n}` : null,
      handoff_status: handoffStatus,
      handoff_synced_at: handed ? at(56, n) : null,
      handoff_tracker: handed ? 'cairn' : null,
      handoff_url: handed && n > 36 ? `https://tasks.montytorr.com/projects/${key}/tasks/${n % 2 ? 100 + n : n}` : null,
    })
    if (n <= 30) {
      f.taskNotes.push({
        id: uid(10, n),
        task_id: uid(7, n),
        actor_type: 'agent',
        actor_id: AGENT,
        note: `Started T-${n}; reading S-${subject ?? 1} first.`,
        kind: 'note',
        facts: n % 2 ? { files: [`src/${n}.ts`] } : null,
        content_hash: hash('note', `T-${n}`),
        created_at: at(11 + n, 1, n),
      })
    }
    if (n % 6 === 0) {
      f.taskComments.push({
        id: uid(11, n),
        task_id: uid(7, n),
        actor_type: 'human',
        actor_id: MAEL_EMAIL,
        content: `Comment on T-${n}.`,
        comment_type: 'comment',
        metadata: {},
        created_at: at(12 + n, 2, n),
        updated_at: at(12 + n, 2, n),
        external_ref: null,
        mutation_id: n === 12 ? uid(12, 12) : null,
      })
    }
    f.taskEvents.push({
      id: uid(13, n),
      task_id: uid(7, n),
      actor_type: 'human',
      actor_id: CAL_EMAIL,
      event: 'created',
      data: { ref: `T-${n}`, title: `Todo ${n}` },
      created_at: at(10 + n, n, n),
      project_id: uid(6, 1),
      owner_user_id: CAL,
      subject_id: subject ? uid(5, subject) : null,
    })
    if (claimed || finished) {
      f.taskEvents.push({
        id: uid(13, 100 + n),
        task_id: uid(7, n),
        actor_type: 'agent',
        actor_id: AGENT,
        event: claimed ? 'claimed' : 'resolved',
        data: { ref: `T-${n}` },
        created_at: at(55, n, 1),
        project_id: uid(6, 1),
        owner_user_id: CAL,
        subject_id: subject ? uid(5, subject) : null,
      })
    }
  }
  // A todo that was deleted: its event outlives it, with no task.
  f.taskEvents.push({
    id: uid(13, 999),
    task_id: null,
    actor_type: 'human',
    actor_id: CAL_EMAIL,
    event: 'task_deleted',
    data: { ref: 'T-64', title: 'Withdrawn' },
    created_at: at(59),
    project_id: uid(6, 1),
    owner_user_id: CAL,
    subject_id: null,
  })

  const files = new Map()
  if (attachments) {
    const subjectBytes = Buffer.from('subject file bytes\n')
    const taskBytes = Buffer.from('task file bytes\n')
    const sha = (b) => createHash('sha256').update(b).digest('hex')
    const subjectPath = `subjects/${uid(5, 17)}/${uid(14, 1)}-margin.txt`
    const taskPath = `${uid(6, 1)}/tasks/${uid(7, 1)}/${uid(14, 2)}-notes.txt`
    files.set(subjectPath, subjectBytes)
    files.set(taskPath, taskBytes)
    f.subjectAttachments.push({
      id: uid(14, 1),
      subject_id: uid(5, 17),
      filename: 'margin.txt',
      mime_type: 'text/plain',
      size_bytes: String(subjectBytes.length),
      storage_path: subjectPath,
      sha256: sha(subjectBytes),
      uploaded_by: CAL_EMAIL,
      user_id: CAL,
      created_at: at(46),
    })
    f.taskAttachments.push({
      id: uid(14, 2),
      task_id: uid(7, 1),
      actor_type: 'human',
      actor_id: CAL_EMAIL,
      filename: `${uid(14, 2)}-notes.txt`,
      original_name: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: String(taskBytes.length),
      storage_path: taskPath,
      sha256: sha(taskBytes),
      metadata: {},
      created_at: at(47),
    })
  }
  return { fixture: f, files }
}

/** Table -> fixture key, in an order that satisfies Croft's foreign keys. */
const SEED_ORDER = [
  ['app_users', 'users'],
  ['user_profiles', 'profiles'],
  ['subject_stages', 'stages'],
  ['tags', 'tags'],
  ['lab_projects', 'labProjects'],
  ['subjects', 'subjects'],
  ['subject_tags', 'subjectTags'],
  ['subject_notes', 'subjectNotes'],
  ['subject_human_notes', 'subjectHumanNotes'],
  ['subject_attachments', 'subjectAttachments'],
  ['projects', 'projects'],
  ['tasks', 'tasks'],
  ['task_notes', 'taskNotes'],
  ['task_comments', 'taskComments'],
  ['task_activity_events', 'taskEvents'],
  ['task_attachments', 'taskAttachments'],
]

const ident = (n) => `"${n}"`

/** Inserts the fixture. `client` is a pg client on a database built from schema.sql. */
export const seedCroft = async (client, fixture) => {
  // The tasks table needs its project and subjects first; parent and duplicate
  // links point at tasks in the same statement, which a single insert allows.
  for (const [table, key] of SEED_ORDER) {
    const rows = fixture[key]
    if (!rows.length) continue
    // comments_text is kept by a trigger on comments, not seeded.
    const use = Object.keys(rows[0])
      .filter((c) => c !== 'comments_text')
      .map(ident)
      .join(', ')
    await client.query(
      `insert into public.${ident(table)} (${use})
       select ${use} from jsonb_populate_recordset(null::public.${ident(table)}, $1::jsonb)`,
      [JSON.stringify(rows)],
    )
  }
  // Child inserts touch their subject and task; put the fixture's own times
  // back, with the touch triggers off, so the database holds what it says.
  await client.query('set constraints all immediate')
  for (const [table, key] of [
    ['subjects', 'subjects'],
    ['tasks', 'tasks'],
  ]) {
    await client.query(`alter table ${ident(table)} disable trigger ${ident(`${table}_touch`)}`)
    await client.query(
      `update ${ident(table)} t set updated_at = u.ts
         from unnest($1::uuid[], $2::timestamptz[]) as u(id, ts) where t.id = u.id`,
      [fixture[key].map((r) => r.id), fixture[key].map((r) => r.updated_at)],
    )
    await client.query(`alter table ${ident(table)} enable trigger ${ident(`${table}_touch`)}`)
  }
  await client.query(`update subject_number_counter set last_number = $1`, [fixture.counter])
  await client.query(
    `insert into subject_number_counter (singleton, last_number) select true, $1
      where not exists (select 1 from subject_number_counter)`,
    [fixture.counter],
  )
  for (const row of fixture.leftBehind) {
    if (row.table === 'api_keys') {
      for (let i = 0; i < row.count; i += 1) {
        await client.query(
          `insert into api_keys (user_id, agent_name, name, key_prefix, key_hash) values ($1, 'agent', $2, $3, $4)`,
          [CAL, `key-${i}`, `pre${i}`, `hash${i}`],
        )
      }
    }
  }
}
