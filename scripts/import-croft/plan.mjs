/**
 * The mapping, as a pure function: a Croft snapshot, what the target already
 * holds and the operator's options go in; the rows to write, the S-n / T-n
 * mapping, the problems and the counts for the report come out. Nothing here
 * touches a database or a file, so every rule is a unit test.
 *
 * Ids are kept. A Croft subject, task, note or attachment keeps its uuid in the
 * new instance, so a link that embeds one (`/api/v1/attachments/<id>/content`)
 * still resolves and the importer never has to chase a foreign key through a
 * lookup of its own making. The one exception is a user that already exists in
 * the target: they are matched by email and keep the target's id.
 */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { around, scanRefs } from './refs.mjs'

export { rewriteRefs } from './refs.mjs'

export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/
export const RESERVED_KEY = 'LAB'
const HANDOFF_REF = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/
const TRACKER = /^[a-z][a-z0-9-]{1,31}$/
const LOG_KINDS = new Set(['note', 'finding', 'decision', 'attempt', 'handoff', 'stage'])
const ENDED = new Set(['done', 'cancelled'])

/** Croft's `visibility` log kind recorded who could see a subject; the Lab has no such thing. */
const KIND_MAP = { visibility: 'note' }

export const DEFAULTS = {
  homeKey: 'LT',
  homeTitle: 'Lab todos',
  cairnUrl: 'https://tasks.montytorr.com',
  croftHost: 'croft.montytorr.com',
}

/** What the API computes for a retry: the first 32 hex of sha256(kind + "\n" + note). */
export const contentHash = (kind, note) =>
  createHash('sha256').update(`${kind}\n${note}`, 'utf8').digest('hex').slice(0, 32)

/** `Name=KEY` pairs, compared without case, as the operator would type them. */
export const parseProjectKeys = (pairs = []) => {
  const keys = new Map()
  const errors = []
  for (const pair of pairs) {
    const at = pair.lastIndexOf('=')
    const name = at > 0 ? pair.slice(0, at).trim() : ''
    const key = at > 0 ? pair.slice(at + 1).trim().toUpperCase() : ''
    if (!name || !PROJECT_KEY.test(key)) {
      errors.push(`--project-key ${JSON.stringify(pair)}: expected "<lab project name>=<KEY>", key 2-10 characters, a letter first`)
      continue
    }
    keys.set(name.toLowerCase(), key)
  }
  return { keys, errors }
}

const pickOwner = ({ email, croftUsers, userMap, targetUsers }) => {
  if (email) {
    const wanted = email.toLowerCase()
    const croft = croftUsers.find((u) => u.email.toLowerCase() === wanted)
    if (croft) return { id: userMap.get(croft.id), email: croft.email }
    const target = targetUsers.find((u) => u.email.toLowerCase() === wanted)
    if (target) return { id: target.id, email: target.email }
    return { error: `--owner ${email}: no such user in Croft or in the target` }
  }
  const active = (u) => !u.deleted_at && !u.banned_until
  const admin =
    croftUsers.find((u) => u.role === 'admin' && active(u)) ??
    targetUsers.find((u) => u.role === 'admin') ??
    croftUsers.find(active) ??
    targetUsers[0]
  if (!admin) return { error: 'no user to own the projects: Croft has none and the target has none' }
  if (userMap.has(admin.id)) return { id: userMap.get(admin.id), email: admin.email }
  return { id: admin.id, email: admin.email }
}

const topoOrder = (tasks) => {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const done = new Set()
  const visiting = new Set()
  const order = []
  const cycle = []
  const visit = (task) => {
    if (done.has(task.id)) return
    if (visiting.has(task.id)) {
      cycle.push(task.id)
      return
    }
    visiting.add(task.id)
    for (const dep of [task.parent_id, task.duplicate_of]) {
      const parent = dep ? byId.get(dep) : null
      if (parent) visit(parent)
    }
    visiting.delete(task.id)
    done.add(task.id)
    order.push(task)
  }
  for (const task of tasks) visit(task)
  return { order, cycle }
}

const withoutKey = (url) => url.replace(/\/+$/, '')

/**
 * @param {object} args
 * @param {object} args.croft   the snapshot from read.mjs
 * @param {object} args.target  what the target holds (write.mjs readTarget)
 * @param {object} args.options see DEFAULTS, plus ownerEmail, projectKeys (Map), allowPrivate,
 *                              enableLab, rewriteRefs
 */
export const buildPlan = ({ croft, target, options }) => {
  const opts = { ...DEFAULTS, enableLab: true, allowPrivate: false, rewriteRefs: false, now: new Date().toISOString(), ...options }
  const errors = []
  const warnings = []
  const notes = []
  const err = (message) => errors.push(message)

  const cairnUrl = withoutKey(opts.cairnUrl)
  if (!/^https:\/\//.test(cairnUrl)) err(`--cairn-url ${opts.cairnUrl}: a cairn hand-off needs an https URL`)
  if (!PROJECT_KEY.test(opts.homeKey) || opts.homeKey === RESERVED_KEY) {
    err(`--home-key ${opts.homeKey}: 2-10 characters, a letter first, and not ${RESERVED_KEY}`)
  }

  // --- users ---------------------------------------------------------------
  const userMap = new Map()
  const targetByEmail = new Map(target.users.map((u) => [u.email.toLowerCase(), u]))
  const takenIds = new Set(target.users.map((u) => u.id))
  const users = []
  const userRows = []
  const seenEmails = new Set()
  for (const u of croft.users) {
    const email = u.email.toLowerCase()
    if (seenEmails.has(email)) {
      err(`Croft has two users with the email ${u.email} (differing only in case)`)
      continue
    }
    seenEmails.add(email)
    const existing = targetByEmail.get(email)
    if (existing) {
      userMap.set(u.id, existing.id)
      users.push({ email: u.email, role: u.role, action: 'reuse', id: existing.id, note: 'already in the target: its password and role are kept' })
      continue
    }
    const id = takenIds.has(u.id) ? randomUUID() : u.id
    takenIds.add(id)
    userMap.set(u.id, id)
    users.push({ email: u.email, role: u.role, action: 'insert', id, note: u.deleted_at ? 'deactivated in Croft: stays deactivated' : u.banned_until ? 'banned in Croft: stays banned' : '' })
    userRows.push({
      id,
      email: u.email,
      encrypted_password: u.encrypted_password,
      role: u.role,
      banned_until: u.banned_until,
      deleted_at: u.deleted_at,
      created_at: u.created_at,
      updated_at: u.updated_at,
    })
  }
  const profileRows = croft.profiles
    .filter((p) => userMap.has(p.id))
    .map((p) => ({
      id: userMap.get(p.id),
      display_name: p.display_name,
      avatar_url: p.avatar_url,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }))
  const userOf = (id) => (id ? (userMap.get(id) ?? null) : null)

  const owner = pickOwner({ email: opts.ownerEmail, croftUsers: croft.users, userMap, targetUsers: target.users })
  if (owner.error) err(owner.error)

  // --- stages --------------------------------------------------------------
  const stageMap = new Map()
  const stages = []
  const stageInserts = []
  const stageUpdates = []
  const targetStages = new Map(target.stages.map((s) => [s.name.toLowerCase(), s]))
  for (const s of croft.stages) {
    const hit = targetStages.get(s.name.toLowerCase())
    if (hit) {
      stageMap.set(s.id, hit.id)
      const differs = []
      if (hit.category !== s.category) differs.push(`category ${hit.category} -> ${s.category}`)
      if (hit.color !== s.color) differs.push(`colour ${hit.color} -> ${s.color}`)
      if (hit.position !== s.position) differs.push(`position ${hit.position} -> ${s.position}`)
      if (differs.length) {
        stageUpdates.push({ id: hit.id, category: s.category, color: s.color, position: s.position })
      }
      stages.push({ name: s.name, action: differs.length ? 'update' : 'reuse', detail: differs.join(', ') })
    } else {
      stageMap.set(s.id, s.id)
      stages.push({ name: s.name, action: 'insert', detail: s.category })
      stageInserts.push({
        id: s.id,
        name: s.name,
        category: s.category,
        color: s.color,
        position: s.position,
        created_at: s.created_at,
      })
    }
  }
  const croftStageNames = new Set(croft.stages.map((s) => s.name.toLowerCase()))
  const targetOnlyStages = target.stages.filter((s) => !croftStageNames.has(s.name.toLowerCase()))
  if (targetOnlyStages.length) {
    notes.push(`stages only in the target, kept: ${targetOnlyStages.map((s) => s.name).join(', ')}`)
  }

  // --- tags ----------------------------------------------------------------
  const tagMap = new Map()
  const tags = []
  const tagRows = []
  const targetTags = new Map(target.tags.map((t) => [t.name.toLowerCase(), t]))
  for (const t of croft.tags) {
    const hit = targetTags.get(t.name.toLowerCase())
    if (hit) {
      tagMap.set(t.id, hit.id)
      tags.push({ name: t.name, action: 'reuse' })
    } else {
      tagMap.set(t.id, t.id)
      tags.push({ name: t.name, action: 'insert' })
      tagRows.push({
        id: t.id,
        name: t.name.toLowerCase(),
        color: t.color,
        position: t.position,
        created_at: t.created_at,
      })
    }
  }

  // --- subjects ------------------------------------------------------------
  const subjectsById = new Map(croft.subjects.map((s) => [s.id, s]))
  const nonLab = croft.subjects.filter((s) => s.visibility !== 'lab')
  if (nonLab.length && !opts.allowPrivate) {
    err(
      `${nonLab.length} subject(s) are not visible to the whole lab in Croft (${nonLab
        .map((s) => `S-${s.number} ${s.visibility}`)
        .join(', ')}). The Lab has no private subjects: importing them shows them to everyone. Review them in Croft, or pass --allow-private to import them as visible to all.`,
    )
  } else if (nonLab.length) {
    warnings.push(`--allow-private: ${nonLab.length} private or members-only subject(s) become visible to every user`)
  }

  const subjectRefs = new Map(croft.subjects.map((s) => [`S-${s.number}`, `LAB-${s.number}`]))
  const highest = croft.subjects.reduce((m, s) => Math.max(m, s.number), 0)
  const counterAfter = Math.max(highest, croft.counter)
  const present = new Set(croft.subjects.map((s) => s.number))
  const gaps = []
  for (let n = 1; n <= counterAfter; n += 1) if (!present.has(n)) gaps.push(n)

  // --- lab projects -> Cairn projects -----------------------------------
  const takenKeys = new Set([...target.projects.map((p) => p.key), ...target.formerKeys])
  const usedKeys = new Map()
  const projectMap = new Map()
  const projectRows = []
  const projects = []
  for (const lp of croft.labProjects) {
    let key = opts.projectKeys?.get(lp.name.toLowerCase()) ?? null
    let source = 'from --project-key'
    if (!key && lp.handoff_tracker === 'cairn' && lp.handoff_target && PROJECT_KEY.test(lp.handoff_target)) {
      key = lp.handoff_target
      source = 'from its cairn hand-off target'
    }
    if (!key) {
      err(
        `lab project "${lp.name}" has no Cairn key to take: its hand-off is ${
          lp.handoff_tracker ? `${lp.handoff_tracker} ${lp.handoff_target}` : 'not set'
        }. Choose one with --project-key "${lp.name}=KEY".`,
      )
      continue
    }
    if (key === RESERVED_KEY) {
      err(`lab project "${lp.name}" would take the key ${RESERVED_KEY}, which is reserved for subjects`)
      continue
    }
    if (key === opts.homeKey) {
      err(`lab project "${lp.name}" would take the key ${key}, which is the home project's: pass --home-key or --project-key`)
      continue
    }
    if (usedKeys.has(key)) {
      err(`lab projects "${usedKeys.get(key)}" and "${lp.name}" would both take the key ${key}`)
      continue
    }
    if (takenKeys.has(key)) {
      err(`lab project "${lp.name}" would take the key ${key}, which the target already uses (live or retired). Choose another with --project-key "${lp.name}=KEY".`)
      continue
    }
    usedKeys.set(key, lp.name)
    projectMap.set(lp.id, { id: lp.id, key })
    projects.push({ name: lp.name, key, source, handoff: lp.handoff_tracker ? `${lp.handoff_tracker} ${lp.handoff_target}` : null, archived: Boolean(lp.archived_at) })
    projectRows.push({
      id: lp.id,
      owner_user_id: owner.id,
      key,
      title: lp.name,
      status: lp.archived_at ? 'archived' : 'active',
      position: lp.position,
      task_counter: 0,
      handoff_tracker: lp.handoff_tracker,
      handoff_target: lp.handoff_target,
      created_at: lp.created_at,
      updated_at: lp.updated_at,
    })
  }

  // --- todos ---------------------------------------------------------------
  const croftProjectKey = new Map(croft.projects.map((p) => [p.id, p.key]))
  if (croft.projects.length !== 1 || croft.projects[0].key !== 'T') {
    warnings.push(
      `Croft holds the projects ${croft.projects.map((p) => p.key).join(', ') || '(none)'}, not just T: every project's tasks are imported as todos and numbered by their new project`,
    )
  }
  const tasksOrdered = [...croft.tasks].sort(
    (a, b) =>
      (croftProjectKey.get(a.project_id) ?? '').localeCompare(croftProjectKey.get(b.project_id) ?? '') || a.number - b.number,
  )

  const home = { needed: false, id: null, key: opts.homeKey, existing: null }
  const existingHome = target.projects.find((p) => p.key === opts.homeKey)
  if (existingHome) {
    if (target.settings?.home_project_id === existingHome.id) {
      home.existing = existingHome
      home.id = existingHome.id
    } else {
      err(`the home project key ${opts.homeKey} is already a project in the target and is not the Lab's home. Choose another with --home-key.`)
    }
  } else if (target.formerKeys.includes(opts.homeKey)) {
    err(`the home project key ${opts.homeKey} is a retired key in the target. Choose another with --home-key.`)
  }
  const homeId = home.id ?? randomUUID()
  const counters = new Map()
  counters.set(homeId, existingHome?.task_counter ?? 0)
  for (const [id] of projectMap) counters.set(id, 0)

  const todoRefs = new Map()
  const numbered = tasksOrdered.map((t) => {
    const subject = t.subject_id ? subjectsById.get(t.subject_id) : null
    const own = subject?.project_id && projectMap.has(subject.project_id) ? subject.project_id : null
    const projectId = own ?? homeId
    if (!own) home.needed = true
    const number = (counters.get(projectId) ?? 0) + 1
    counters.set(projectId, number)
    const key = own ? projectMap.get(own).key : opts.homeKey
    const croftRef = `${croftProjectKey.get(t.project_id) ?? 'T'}-${t.number}`
    todoRefs.set(croftRef, `${key}-${number}`)
    return { task: t, projectId, number, key, croftRef, newRef: `${key}-${number}`, subject }
  })

  if (home.needed && !existingHome) {
    projectRows.push({
      id: homeId,
      owner_user_id: owner.id,
      key: opts.homeKey,
      title: opts.homeTitle,
      status: 'active',
      position: croft.labProjects.length,
      task_counter: 0,
      handoff_tracker: null,
      handoff_target: null,
      created_at: opts.now,
      updated_at: opts.now,
    })
    projects.push({ name: opts.homeTitle, key: opts.homeKey, source: 'home for todos with no lab project', handoff: null, archived: false })
  }
  for (const row of projectRows) {
    if (counters.has(row.id)) row.task_counter = counters.get(row.id)
  }
  const homeUpdate = home.existing && home.needed ? { id: homeId, task_counter: counters.get(homeId) } : null

  // Every prose field goes through here, whether or not --rewrite-refs is set,
  // so the report can say what the flag would do. The text only changes with it.
  const prose = {
    tables: {},
    samples: [],
    unknown: new Set(),
  }
  const text = (table, owner, field, value) => {
    const scan = scanRefs(value, subjectRefs, todoRefs)
    const t = (prose.tables[table] ??= { fields: 0, rewritten: 0, left: 0, unknown: 0 })
    t.fields += value ? 1 : 0
    t.rewritten += scan.rewritten.length
    t.left += scan.left.length
    t.unknown += scan.unknown.length
    for (const u of scan.unknown) prose.unknown.add(u)
    for (const r of scan.rewritten) {
      prose.samples.push({ table, owner, field, from: r.from, to: r.to, ...around(value, r.at, r.from.length, scan.rewritten) })
    }
    return opts.rewriteRefs ? scan.text : value
  }

  // --- subject rows ----------------------------------------------------
  const subjectRows = croft.subjects.map((s) => ({
    id: s.id,
    number: s.number,
    title: text('subjects', `LAB-${s.number}`, 'title', s.title),
    body: text('subjects', `LAB-${s.number}`, 'body', s.body),
    stage_id: stageMap.get(s.stage_id),
    owner_user_id: userOf(s.owner_user_id),
    project_id: s.project_id && projectMap.has(s.project_id) ? s.project_id : null,
    conclusion: text('subjects', `LAB-${s.number}`, 'conclusion', s.conclusion),
    concluded_at: s.concluded_at,
    position: s.position,
    actor_type: s.actor_type,
    actor_id: s.actor_id,
    created_at: s.created_at,
    updated_at: s.updated_at,
    archived_at: s.archived_at,
  }))
  for (const s of croft.subjects) {
    if (!stageMap.has(s.stage_id)) err(`S-${s.number} is in a stage that is not in Croft's stage list`)
    if (s.project_id && !projectMap.has(s.project_id)) {
      err(`S-${s.number} is in a lab project that could not be given a key (see above)`)
    }
  }

  const subjectTagRows = []
  for (const st of croft.subjectTags) {
    if (!subjectsById.has(st.subject_id)) continue
    subjectTagRows.push({ subject_id: st.subject_id, tag_id: tagMap.get(st.tag_id) })
  }

  const logKinds = new Map()
  const subjectNoteRows = []
  for (const n of croft.subjectNotes) {
    const kind = KIND_MAP[n.kind] ?? n.kind
    if (!LOG_KINDS.has(kind)) {
      err(`a subject log entry has the kind "${n.kind}", which the Lab does not know`)
      continue
    }
    logKinds.set(n.kind, (logKinds.get(n.kind) ?? 0) + 1)
    subjectNoteRows.push({
      id: n.id,
      subject_id: n.subject_id,
      kind,
      note: text('subject_notes', `LAB-${subjectsById.get(n.subject_id)?.number}`, `log ${kind}`, n.note),
      actor_type: n.actor_type,
      actor_id: n.actor_id,
      user_id: userOf(n.user_id),
      content_hash: n.content_hash ?? contentHash(kind, n.note),
      created_at: n.created_at,
    })
  }

  const humanNoteRows = croft.subjectHumanNotes.map((n) => ({
    id: n.id,
    subject_id: n.subject_id,
    body: text('subject_human_notes', `LAB-${subjectsById.get(n.subject_id)?.number}`, 'note', n.body),
    user_id: userOf(n.user_id),
    actor_type: n.actor_type,
    actor_id: n.actor_id,
    created_at: n.created_at,
    updated_at: n.updated_at,
  }))

  const files = []
  const subjectAttachmentRows = croft.subjectAttachments.map((a) => {
    let path = a.storage_path
    if (path.startsWith('lab/subjects/')) path = a.storage_path
    else if (path.startsWith('subjects/')) path = `lab/${path}`
    else path = `lab/subjects/${a.subject_id}/${posix.basename(path)}`
    files.push({ kind: 'subject', from: a.storage_path, to: path, sha256: a.sha256, size: Number(a.size_bytes) })
    return {
      id: a.id,
      subject_id: a.subject_id,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      storage_path: path,
      sha256: a.sha256,
      uploaded_by: a.uploaded_by,
      user_id: userOf(a.user_id),
      created_at: a.created_at,
    }
  })

  const taskRows = []
  const taskNoteRows = []
  const hand = { tracker: new Map(), derivedUrls: 0, ended: 0, open: 0 }
  let claimsCleared = 0
  let releasedToTodo = 0
  const statusCounts = new Map()
  const perProject = new Map()
  const mapping = { subjects: {}, todos: {} }
  for (const s of croft.subjects) mapping.subjects[`S-${s.number}`] = `LAB-${s.number}`

  const ordered = topoOrder(numbered.map((n) => n.task))
  if (ordered.cycle.length) err(`tasks form a parent/duplicate cycle: ${ordered.cycle.length} task(s) involved`)
  const numberedById = new Map(numbered.map((n) => [n.task.id, n]))

  for (const t of ordered.order) {
    const n = numberedById.get(t.id)
    const { projectId, number, croftRef, newRef } = n
    mapping.todos[croftRef] = newRef
    perProject.set(n.key, (perProject.get(n.key) ?? 0) + 1)
    statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1)

    let { handoff_tracker: tracker, handoff_ref: ref, handoff_url: url } = t
    if (tracker) {
      hand.tracker.set(tracker, (hand.tracker.get(tracker) ?? 0) + 1)
      if (!TRACKER.test(tracker)) err(`${croftRef}: the hand-off tracker "${tracker}" is not a valid tracker name`)
      if (!ref || /\s/.test(ref) || ref.length > 200) err(`${croftRef}: the hand-off ref ${JSON.stringify(ref)} is not valid`)
      if (tracker === 'cairn') {
        if (!url) {
          const m = HANDOFF_REF.exec(ref ?? '')
          if (!m) {
            err(`${croftRef}: handed off to cairn as ${JSON.stringify(ref)}, which is not KEY-n, so its URL cannot be derived`)
          } else {
            url = `${cairnUrl}/projects/${m[1]}/tasks/${Number(m[2])}`
            hand.derivedUrls += 1
          }
        } else if (!/^https:\/\//.test(url)) {
          err(`${croftRef}: a cairn hand-off needs an https URL, found ${url}`)
        }
      }
      if (ENDED.has(t.handoff_status)) hand.ended += 1
      else hand.open += 1
    }

    const handoffOpen = Boolean(tracker) && !ENDED.has(t.handoff_status)
    const claimed = t.claimed_by != null
    if (claimed) claimsCleared += 1
    let status = t.status
    if (claimed && status === 'doing' && !handoffOpen) {
      status = 'todo'
      releasedToTodo += 1
    }

    const subject = n.subject
    taskRows.push({
      id: t.id,
      project_id: projectId,
      number,
      title: text('tasks', newRef, 'title', t.title),
      description: text('tasks', newRef, 'description', t.description),
      type: t.type,
      status,
      priority: t.priority,
      labels: t.labels,
      due_date: t.due_date,
      position: t.position,
      actor_type: t.actor_type,
      actor_id: t.actor_id,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      claimed_session: null,
      attempt: t.attempt,
      checkpoint_summary: t.checkpoint_summary,
      checkpoint_payload: t.checkpoint_payload,
      checkpoint_at: t.checkpoint_at,
      checkpoint_version: t.checkpoint_version,
      checkpoint_mutation_id: t.checkpoint_mutation_id,
      ownership_version: t.ownership_version,
      blocked_reason: t.blocked_reason,
      blocked_at: t.blocked_at,
      resolution: text('tasks', newRef, 'resolution', t.resolution),
      resolution_kind: t.resolution_kind,
      resolved_at: t.resolved_at,
      resolved_by: t.resolved_by,
      memory_session_id: null,
      observation_ids: null,
      created_at: t.created_at,
      updated_at: t.updated_at,
      external_ref: `croft:${opts.croftHost}/${croftRef}`,
      external_url: t.external_url,
      duplicate_of: t.duplicate_of,
      parent_id: t.parent_id,
      assignee_user_id: userOf(t.assignee_user_id),
      subject_id: subject ? subject.id : null,
      handoff_tracker: tracker ?? null,
      handoff_ref: ref ?? null,
      handoff_url: tracker ? url : null,
      handoff_status: t.handoff_status,
      handoff_synced_at: t.handoff_synced_at,
    })
    if (!userOf(t.assignee_user_id)) err(`${croftRef}: its assignee is not a Croft user`)
    if (t.external_ref && t.external_ref !== `croft:${opts.croftHost}/${croftRef}`) {
      warnings.push(`${croftRef} had its own external ref ${JSON.stringify(t.external_ref)}, replaced; kept in a note on the todo`)
      taskNoteRows.push({
        id: randomUUID(),
        task_id: t.id,
        actor_type: 'agent',
        actor_id: 'croft-import',
        note: `Imported from Croft ${croftRef}. Its external ref there was ${t.external_ref}.`,
        kind: 'note',
        facts: null,
        content_hash: contentHash('note', `croft-import external_ref ${t.external_ref}`),
        created_at: t.updated_at,
      })
    }
  }

  for (const n of croft.taskNotes) {
    if (!numberedById.has(n.task_id)) continue
    taskNoteRows.push({
      id: n.id,
      task_id: n.task_id,
      actor_type: n.actor_type,
      actor_id: n.actor_id,
      note: text('task_notes', numberedById.get(n.task_id)?.newRef, n.kind, n.note),
      kind: n.kind,
      facts: n.facts,
      content_hash: n.content_hash,
      created_at: n.created_at,
    })
  }

  const taskCommentRows = croft.taskComments
    .filter((c) => numberedById.has(c.task_id))
    .map((c) => ({
      id: c.id,
      task_id: c.task_id,
      actor_type: c.actor_type,
      actor_id: c.actor_id,
      content: text('task_comments', numberedById.get(c.task_id)?.newRef, 'comment', c.content),
      comment_type: c.comment_type,
      metadata: c.metadata,
      created_at: c.created_at,
      updated_at: c.updated_at,
      external_ref: c.external_ref,
      mutation_id: c.mutation_id,
    }))

  const taskAttachmentRows = croft.taskAttachments
    .filter((a) => numberedById.has(a.task_id))
    .map((a) => {
      files.push({ kind: 'task', from: a.storage_path, to: a.storage_path, sha256: a.sha256, size: Number(a.size_bytes) })
      return {
        id: a.id,
        task_id: a.task_id,
        actor_type: a.actor_type,
        actor_id: a.actor_id,
        filename: a.filename,
        original_name: a.original_name,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        storage_path: a.storage_path,
        sha256: a.sha256,
        metadata: a.metadata,
        created_at: a.created_at,
      }
    })

  // --- activity events -----------------------------------------------------
  const allowedEvents = target.eventKinds
  const skippedEvents = new Map()
  const eventRows = []
  for (const e of croft.taskEvents) {
    if (allowedEvents && !allowedEvents.has(e.event)) {
      skippedEvents.set(e.event, (skippedEvents.get(e.event) ?? 0) + 1)
      continue
    }
    const n = e.task_id ? numberedById.get(e.task_id) : null
    // An event for a task that is gone keeps the lab's home as its project, so
    // the feed still files it somewhere; the ref it referred to is in `data`.
    const projectId = n ? n.projectId : home.needed || home.existing ? homeId : null
    eventRows.push({
      id: e.id,
      task_id: n ? e.task_id : null,
      actor_type: e.actor_type,
      actor_id: e.actor_id,
      event: e.event,
      data: e.data,
      created_at: e.created_at,
      project_id: projectId,
      owner_user_id: userOf(e.owner_user_id) ?? owner.id ?? null,
      subject_id: e.subject_id ?? (n?.subject ? n.subject.id : null),
    })
  }

  const rewrites = {
    applied: Boolean(opts.rewriteRefs),
    byTable: prose.tables,
    totals: Object.values(prose.tables).reduce(
      (sum, t) => ({ rewritten: sum.rewritten + t.rewritten, left: sum.left + t.left, unknown: sum.unknown + t.unknown }),
      { rewritten: 0, left: 0, unknown: 0 },
    ),
    unknown: [...prose.unknown].sort(),
    sample: evenly(prose.samples, 10),
  }

  // --- the table of what happens to what --------------------------------------
  const counts = {
    app_users: { source: croft.users.length, insert: userRows.length, reuse: croft.users.length - userRows.length },
    user_profiles: { source: croft.profiles.length, insert: profileRows.length },
    lab_stages: { source: croft.stages.length, insert: stageInserts.length, update: stageUpdates.length, reuse: croft.stages.length - stageInserts.length - stageUpdates.length },
    lab_tags: { source: croft.tags.length, insert: tagRows.length, reuse: croft.tags.length - tagRows.length },
    projects: { source: croft.labProjects.length, insert: projectRows.length },
    subjects: { source: croft.subjects.length, insert: subjectRows.length },
    subject_tags: { source: croft.subjectTags.length, insert: subjectTagRows.length },
    subject_notes: { source: croft.subjectNotes.length, insert: subjectNoteRows.length },
    subject_human_notes: { source: croft.subjectHumanNotes.length, insert: humanNoteRows.length },
    subject_attachments: { source: croft.subjectAttachments.length, insert: subjectAttachmentRows.length },
    tasks: { source: croft.tasks.length, insert: taskRows.length },
    task_notes: { source: croft.taskNotes.length, insert: taskNoteRows.length },
    task_comments: { source: croft.taskComments.length, insert: taskCommentRows.length },
    task_attachments: { source: croft.taskAttachments.length, insert: taskAttachmentRows.length },
    task_activity_events: { source: croft.taskEvents.length, insert: eventRows.length, skipped: croft.taskEvents.length - eventRows.length },
  }

  const skipped = [...croft.leftBehind.filter((l) => l.count > 0).map((l) => ({ what: l.table, count: l.count, why: l.why }))]
  for (const [event, count] of skippedEvents) {
    skipped.push({ what: `task_activity_events ${event}`, count, why: 'the target does not know this event kind' })
  }
  for (const [kind, count] of logKinds) {
    if (KIND_MAP[kind]) skipped.push({ what: `subject_notes ${kind}`, count, why: `imported as kind ${KIND_MAP[kind]}`, imported: true })
  }
  if (claimsCleared) skipped.push({ what: 'task claims', count: claimsCleared, why: 'claims are cleared', imported: true })
  if (releasedToTodo) skipped.push({ what: 'doing todos', count: releasedToTodo, why: 'their claim is gone, so they go back to todo', imported: true })

  return {
    options: { ...opts, projectKeys: undefined },
    errors,
    warnings,
    notes,
    users,
    stages,
    tags,
    projects,
    home: { needed: home.needed, key: opts.homeKey, existing: Boolean(home.existing) },
    subjects: {
      total: croft.subjects.length,
      archived: croft.subjects.filter((s) => s.archived_at).length,
      highest,
      croftCounter: croft.counter,
      counterAfter,
      gaps,
    },
    todos: {
      total: taskRows.length,
      perProject: Object.fromEntries(perProject),
      statuses: Object.fromEntries(statusCounts),
      handoff: { byTracker: Object.fromEntries(hand.tracker), derivedUrls: hand.derivedUrls, open: hand.open, ended: hand.ended },
      claimsCleared,
      releasedToTodo,
    },
    logKinds: Object.fromEntries(logKinds),
    counts,
    skipped,
    rewrites,
    mapping,
    owner: owner.email ? { id: owner.id, email: owner.email } : null,
    // What the writer needs.
    rows: {
      app_users: userRows,
      user_profiles: profileRows,
      lab_stages: { insert: stageInserts, update: stageUpdates },
      lab_tags: tagRows,
      projects: projectRows,
      home: { id: homeId, needed: home.needed, existing: homeUpdate },
      lab_settings: { enabled: opts.enableLab, home_project_id: home.needed || home.existing ? homeId : null, updated_by: owner.id },
      subjects: subjectRows,
      subject_tags: subjectTagRows,
      subject_notes: subjectNoteRows,
      subject_human_notes: humanNoteRows,
      subject_attachments: subjectAttachmentRows,
      tasks: taskRows,
      task_notes: taskNoteRows,
      task_comments: taskCommentRows,
      task_attachments: taskAttachmentRows,
      task_activity_events: eventRows,
    },
    files,
    counterAfter,
  }
}

/** `n` items spread evenly across the list, in order, so a sample is not all from one table. */
const evenly = (items, n) => {
  if (items.length <= n) return items
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)])
}
