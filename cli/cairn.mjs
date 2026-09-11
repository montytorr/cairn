#!/usr/bin/env node
/**
 * cairn — the single implementation every agent calls.
 *
 * Deliberately dependency-free: Node 22's built-in fetch is enough, so the CLI
 * can be dropped onto a box and run without an install step. Claude Code,
 * Codex and OpenClaw all reach it the same way, through a shell.
 *
 * Output discipline is the point, not a detail. Lists are TSV with the keys
 * emitted once as a header, nulls omitted, a count-first line so the caller
 * can paginate before parsing, and — on search — an estimated token cost per
 * row so the model can decline to open something.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Credentials come from the environment, falling back to ~/.cairn/env — so an
 * agent skill works without the user having to edit a shell profile first.
 * Format is plain KEY=value lines.
 */
const fileEnv = () => {
  try {
    const path = `${homedir()}/.cairn/env`
    if (!existsSync(path)) return {}
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

const FILE_ENV = fileEnv()
const BASE = (process.env.CAIRN_BASE_URL || FILE_ENV.CAIRN_BASE_URL || 'http://localhost:3000')
  .replace(/\/+$/, '')
const KEY = process.env.CAIRN_API_KEY || FILE_ENV.CAIRN_API_KEY || ''

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const [name, inline] = arg.slice(2).split('=')
    if (inline !== undefined) flags[name] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i]
    else flags[name] = true
  } else positional.push(arg)
}

const FORMAT = flags.json ? 'json' : flags.pretty ? 'pretty' : 'tsv'

/** `-` means read the value from stdin, so long markdown bodies stay off argv. */
const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
const resolveValue = async (v) => (v === '-' ? (await readStdin()).trim() : v)

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
/**
 * Gateway errors are transient and worth waiting out.
 *
 * A deploy takes the app down for a few seconds, and during that window every
 * call returns 502 from the proxy. That is survivable for a human retrying by
 * hand and fatal for a batch import or a session-end hook, which gets one
 * chance to record what happened before the session is gone.
 */
const TRANSIENT = new Set([502, 503, 504])
const RETRIES = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const request = async (method, path, body, { soft = false } = {}) => {
  if (!KEY) die('CAIRN_API_KEY is not set (env, or ~/.cairn/env).')
  let res
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (attempt >= RETRIES) die(`cannot reach ${BASE}: ${error.message}`)
      await sleep(500 * 2 ** attempt)
      continue
    }
    if (TRANSIENT.has(res.status) && attempt < RETRIES) {
      await sleep(500 * 2 ** attempt)
      continue
    }
    break
  }

  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (soft) return null
    die(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!payload.success) {
    // `soft` callers are probing, not asserting. `cairn know <word>` tries the
    // word as a slug first and falls back to searching, and dying on the miss
    // made the fallback unreachable.
    if (soft) return null
    // Surface the server's guidance verbatim — it names valid enum values and,
    // on a refused close, suggests a resolution. Swallowing that would turn a
    // useful round-trip into a wasted one.
    const extra = payload.suggestedResolution
      ? `\nsuggested: ${payload.suggestedResolution}`
      : payload.issues
        ? `\n${payload.issues
            .map((i) => `  ${(i.path ?? []).join('.') || '(body)'}: ${i.message}`)
            .join('\n')}`
        : ''
    // 409 gets its own exit code so a caller can branch on "someone else has it".
    die(`${payload.error}${extra}`, payload.code === 'already_claimed' ? 9 : 1)
  }
  return payload.data
}

/**
 * The server validates against a MIME allowlist, and a Blob with no `type`
 * arrives as application/octet-stream — so every legitimate upload would be
 * rejected. Node has no mime lookup built in, so infer from the extension.
 */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', tar: 'application/x-tar',
  gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

const mimeOf = (filePath) => {
  const ext = filePath.toLowerCase().split('.').pop()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const upload = async (path, filePath) => {
  if (!KEY) die('CAIRN_API_KEY is not set (env, or ~/.cairn/env).')
  if (!existsSync(filePath)) die(`no such file: ${filePath}`)

  const form = new FormData()
  // Let fetch set the multipart boundary; do not send a Content-Type header.
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeOf(filePath) }), basename(filePath))

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  }).catch((error) => die(`cannot reach ${BASE}: ${error.message}`))

  const payload = await res.json().catch(() => null)
  if (!payload?.success) {
    die(payload?.error ?? `upload failed with ${res.status}`)
  }
  return payload.data
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const flatten = (value, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined || v === '') continue // omit nulls entirely
    if (Array.isArray(v)) {
      if (!v.length) continue
      // An array of objects joined with a comma is a row of "[object Object]".
      // Index them instead, so `findings.0.note` is readable and greppable.
      if (v.some((item) => item && typeof item === 'object')) {
        v.forEach((item, i) => flatten(item, `${key}.${i}`, out))
      } else {
        out[key] = v.join(',')
      }
    } else if (typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

const emit = (data, opts = {}) => {
  if (FORMAT === 'json') return console.log(JSON.stringify(data, null, 2))
  if (FORMAT === 'pretty') return console.log(JSON.stringify(data, null, 2))

  const rows = opts.rows ? opts.rows(data) : Array.isArray(data) ? data : null
  if (!rows) {
    const flat = flatten(data)
    for (const [k, v] of Object.entries(flat)) console.log(`${k}\t${v}`)
    return
  }

  console.log(`#${rows.length}`) // count first: paginate before parsing
  if (rows.length === 0) return
  const flatRows = rows.map((r) => flatten(r))
  const cols = opts.columns ?? [...new Set(flatRows.flatMap((r) => Object.keys(r)))]
  console.log(cols.join('\t'))
  for (const r of flatRows) console.log(cols.map((c) => r[c] ?? '').join('\t'))
}

/** Comma or repeated-flag list, e.g. --label a,b --label c. */
/**
 * Which Cairn project a directory belongs to.
 *
 * The server can guess from sessions already recorded against a cwd, but only
 * after the first one. This is the explicit answer, kept next to the
 * credentials: a longest-prefix map in ~/.cairn/projects.json, so a monorepo
 * subdirectory can override its parent.
 */
const PROJECT_MAP_PATH = join(homedir(), '.cairn', 'projects.json')

const readProjectMap = () => {
  try {
    return JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const projectForDir = (dir) => {
  const map = readProjectMap()
  let best = null
  for (const [path, key] of Object.entries(map)) {
    if ((dir === path || dir.startsWith(`${path}/`)) && (!best || path.length > best[0].length)) {
      best = [path, key]
    }
  }
  return best?.[1] ?? null
}

const gitRoot = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const splitList = (v) => {
  if (v === undefined || v === true) return []
  const parts = Array.isArray(v) ? v : [v]
  return parts.flatMap((p) => String(p).split(',')).map((x) => x.trim()).filter(Boolean)
}

/**
 * The briefing, as text a model reads once at the top of a session.
 *
 * Ordered by what changes behaviour soonest: what you are still holding, then
 * what is moving around you, then where the last session stopped, then what is
 * known here. Anything with nothing to say prints nothing at all -- an empty
 * heading is noise that trains the reader to skip the block.
 */
const renderContext = (d, { fileOnly = false } = {}) => {
  const out = []

  // A file read is a narrow question. Answering it with the whole project
  // briefing, on every Read, is how an injection channel becomes noise the
  // reader learns to skip -- and then the one time it matters, it is skipped.
  if (fileOnly) {
    const f = d.file
    if (!f || (!f.tasks.length && !f.knowledge.length)) return ''
    out.push(`## Cairn knows about ${f.path}`)
    for (const t of f.tasks) {
      out.push(`  ${t.ref}  ${t.status}${t.resolved ? ' (answered)' : ''}  ${truncate(t.title, 54)}`)
    }
    for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 54)}`)
    for (const sn of f.sessions.slice(0, 1)) {
      if (sn.nextSteps) out.push(`  last session here: ${truncate(sn.nextSteps, 160)}`)
    }
    return `${out.join('\n')}\n`
  }

  const where = d.project ? `[${d.project}]` : '[unfiled]'
  out.push(`## Cairn ${where}`)

  if (d.held?.length) {
    out.push('', 'You are holding:')
    for (const t of d.held) {
      const quiet = t.quiet ? '  <- no note in 24h; checkpoint or release it' : ''
      out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 58)}${quiet}`)
    }
  }

  if (d.inFlight?.length) {
    out.push('', 'In flight here:')
    for (const t of d.inFlight) {
      out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 52)}${t.claimedBy ? `  (${t.claimedBy})` : ''}`)
    }
  }

  if (d.lastSession?.nextSteps) {
    out.push('', `Last session here left off (${d.lastSession.agent ?? 'unknown'}):`)
    out.push(`  ${truncate(d.lastSession.nextSteps, 400)}`)
  }

  if (d.knowledge?.length) {
    out.push('', 'Known here (cairn know <slug>):')
    for (const k of d.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 58)}`)
  }

  if (d.staleClaims?.length) {
    out.push('', 'Stale claims (lease expired, takeable):')
    for (const t of d.staleClaims) out.push(`  ${t.ref}  held ${t.heldFor} by ${t.claimedBy}`)
  }

  if (d.file) {
    const f = d.file
    if (f.tasks.length || f.knowledge.length) {
      out.push('', `About ${f.path}:`)
      for (const t of f.tasks) out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 56)}`)
      for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 56)}`)
    }
  }

  if (out.length === 1) return ''
  out.push('', 'Start with: cairn check "<subject>"')
  return `${out.join('\n')}\n`
}

const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const HELP = `cairn — agent-first task tracker and shared memory

  ALWAYS START HERE
    cairn check "<subject>"        what has already been done or debugged
                                   searches tasks, work-log notes, knowledge and
                                   sessions; --kinds task,note,knowledge,session

  read
    cairn list [--project K] [--status S] [--type T] [--label L] [--mine]
    cairn show <ref>               e.g. CAI-42
    cairn log <ref> [--kind K]     the work log
    cairn projects

  write
    cairn add "<title>" --project K [--type bug] [--priority high] [--body -]
    cairn update <ref> [--title T] [--status S] [--type T] [--priority P]
    cairn update <ref> --also-project HM,AT      work that spans several projects
    cairn update <ref> --project OTHER      moves it; the ref changes
    cairn note <ref> "<text>" [--kind note|finding|decision|attempt|handoff]
    cairn comment <ref> "<text>"
    cairn done <ref> --resolution "<what was actually done>" [--kind fixed]
    cairn cancel <ref> --resolution "<why it is being dropped>" [--kind wont-fix]
    cairn done <ref> --duplicate-of CAI-31 --resolution "…"   points at the original
    cairn attach <ref> <file>      |   cairn files <ref>

  sub-tasks
    cairn add "<title>" --project K --parent CAI-42   file it under an existing task
    cairn children <ref>                    the direct split
    cairn update <ref> --parent CAI-42 | --no-parent

  history
    cairn history <ref>                     what changed, when, and who changed it

  dependencies
    cairn deps <ref>                        what blocks this, and what it blocks
    cairn blockedby <ref> <other>           mark <ref> as blocked by <other>
    cairn unblockedby <ref> <other>         remove that link

  labels
    cairn labels                            every label in use, busiest first
    cairn labels rename <from> <to>         renaming onto an existing label merges them
    cairn labels remove <label>

  projects
    cairn map [<KEY>|none]                       which project this directory is
    cairn projects [--archived]                  --archived includes retired ones
    cairn project rename <KEY> "<title>"
    cairn project archive <KEY>                  hides it; the tasks stay searchable
    cairn project restore <KEY>
    cairn project delete <KEY> --confirm <KEY>   deletes every task in it

  memory
    cairn context                  the briefing: what you hold, what is in flight,
                                   where the last session here stopped, what is known
    cairn learn "<title>" --body - record what we now know
                                   --project K  true of that project
                                   --entity E   true of that grouping (cairn entities)
                                   neither      true everywhere
    cairn entities                 groupings a fact can be true of, and their projects
    cairn entities assign|unassign <key> --project A,B
    cairn entities rename <key> --key <new> --title "T"
    cairn know [<slug>|<query>]    read it back, or list what applies here
    cairn relearn <slug> --body -  correct it
    cairn unlearn <slug> [--superseded-by <slug>]
    cairn session list             recent sessions
    cairn session end --id <id>    write the episodic record, checkpoint what is held
    cairn reconcile                release your own claims that went quiet

  coordinate
    cairn claim <ref>              exits 9 if another agent holds it
    cairn beat <ref>               keep a claim alive
    cairn checkpoint <ref> --summary "<where things stand>"
    cairn release <ref>
    cairn block <ref> --reason "<why>"   |   cairn unblock <ref>

  output
    --json | --pretty              default is TSV: count line, header, rows
    --body -  /  --resolution -    read the value from stdin

  env: CAIRN_BASE_URL, CAIRN_API_KEY
`

const need = (v, msg) => (v === undefined || v === true ? die(msg) : v)

/** Shared by `done` and `cancel`: both close, and both must say how. */
const closeTask = async (status, defaultKind) => {
  const verb = status === 'done' ? 'done' : 'cancel'
  const ref = need(positional[0], `usage: cairn ${verb} <ref> --resolution "<why>"`)
  const resolution = await resolveValue(
    need(flags.resolution, 'a --resolution is required: say what was actually done, and why'),
  )
  const body = { status, resolution, resolutionKind: flags.kind ?? defaultKind }
  // Naming the original is what makes "duplicate" useful to whoever finds it.
  if (flags['duplicate-of']) {
    body.duplicateOf = flags['duplicate-of']
    body.resolutionKind = 'duplicate'
  }
  emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
}

/** `from -> to`, or the raw keys, kept to one short cell. */
const summariseEvent = (data) => {
  if (!data || typeof data !== 'object') return ''
  if ('from' in data || 'to' in data) {
    const from = Array.isArray(data.from) ? data.from.join('|') : (data.from ?? '')
    const to = Array.isArray(data.to) ? data.to.join('|') : (data.to ?? '')
    return `${from} -> ${to}`
  }
  return Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

const commands = {
  async check() {
    const q = need(positional[0], 'usage: cairn check "<subject>"')
    const params = new URLSearchParams({ q })
    if (flags.project) params.set('project', flags.project)
    if (flags.type) params.set('type', flags.type)
    if (flags.kinds) params.set('kinds', flags.kinds)
    if (flags.tasks) params.set('tasksOnly', '1')
    const data = await request('GET', `/api/v1/search?${params}`)
    emit(data, {
      rows: (d) =>
        d.results.map((r) => ({
          kind: r.kind ?? 'task',
          ref: r.ref,
          status: r.status ?? '',
          type: r.type ?? '',
          answered: r.resolved ? 'yes' : '',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
      columns: ['kind', 'ref', 'status', 'type', 'answered', 'tokens', 'title'],
    })
    if (FORMAT !== 'tsv') return

    if (data.results.length === 0) {
      process.stderr.write('nothing found — this subject looks new\n')
      return
    }

    // Widening only happens when the precise query came back thin, so a result
    // set that is entirely loose means nothing actually matched the subject.
    // Without saying so, twenty plausible-looking rows read as prior work.
    const loose = data.results.filter((r) => r.loose).length
    if (loose === data.results.length) {
      process.stderr.write(
        `no precise match — all ${loose} rows are loose word overlaps, so treat this subject as new unless one genuinely fits\n`,
      )
    } else if (loose > 0) {
      process.stderr.write(`${data.results.length - loose} precise, ${loose} loose\n`)
    }
  },

  async list() {
    const project = need(flags.project ?? positional[0], 'usage: cairn list --project <KEY>')
    const params = new URLSearchParams()
    for (const k of ['status', 'type', 'label', 'limit', 'offset']) {
      if (flags[k]) params.set(k, flags[k])
    }
    if (flags.mine) params.set('claimed_by', process.env.CAIRN_AGENT ?? '')
    const data = await request('GET', `/api/v1/projects/${project}/tasks?${params}`)
    emit(data, {
      rows: (d) =>
        d.tasks.map((t) => ({
          ref: `${t.project?.key ?? project}-${t.number}`,
          status: t.status,
          type: t.type,
          priority: t.priority,
          held: t.claimed_by ?? '',
          answered: t.resolution ? 'yes' : '',
          title: truncate(t.title, 70),
        })),
      columns: ['ref', 'status', 'type', 'priority', 'held', 'answered', 'title'],
    })
  },

  async show() {
    const ref = need(positional[0], 'usage: cairn show <ref>')
    // A digest by default: the answer in full, findings and decisions, a
    // clipped body, and a note of what was withheld. `--full` for everything.
    const suffix = flags.full ? '' : '?view=digest'
    const data = await request('GET', `/api/v1/tasks/${ref}${suffix}`)
    emit(data)
    if (FORMAT === 'tsv' && data.omitted) {
      const { descriptionBytes, attemptsAndNotes, tokensToFetchFull } = data.omitted
      if (descriptionBytes || attemptsAndNotes) {
        process.stderr.write(
          `withheld: ${descriptionBytes}B of body, ${attemptsAndNotes} attempt/note(s)` +
            ` — cairn show ${ref} --full is ~${tokensToFetchFull} tokens\n`,
        )
      }
    }
  },

  async projects() {
    const suffix = flags.archived ? '?archived=1' : ''
    emit(await request('GET', `/api/v1/projects${suffix}`))
  },

  async add() {
    const title = need(positional[0], 'usage: cairn add "<title>" --project <KEY>')
    const project = need(flags.project, 'a --project is required')

    // Warn on a near-duplicate rather than silently filing one.
    //
    // websearch_to_tsquery ANDs its terms, so passing the whole title finds
    // nothing unless a prior task shares every word. For a similarity check we
    // want the opposite, so OR the distinctive words together instead.
    const terms = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
    const probe = terms.length ? terms.join(' OR ') : title
    // Tasks only. "Has this already been filed" is a question about tasks, and
    // answering it with a session from three weeks ago is noise in front of the
    // one thing the agent is about to decide.
    const dupes = await request(
      'GET',
      `/api/v1/search?${new URLSearchParams({ q: probe, kinds: 'task' })}`,
    )
    if (dupes.results.length > 0) {
      process.stderr.write('similar existing work:\n')
      for (const r of dupes.results.slice(0, 3)) {
        process.stderr.write(`  ${r.ref} [${r.status}] ${r.title}\n`)
      }
    }

    const body = { title }
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    if (flags.parent) body.parentRef = flags.parent
    emit(await request('POST', `/api/v1/projects/${project}/tasks`, body))
  },

  async update() {
    const ref = need(positional[0], 'usage: cairn update <ref> --status <s>')
    const body = {}
    if (flags.title) body.title = flags.title
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    // Passed through so a single update can move to a closing status and say
    // how in one call — without it the API rightly refuses the move.
    if (flags.resolution) body.resolution = await resolveValue(flags.resolution)
    if (flags.kind) body.resolutionKind = flags.kind
    if (flags.parent) body.parentRef = flags.parent
    if (flags['no-parent']) body.parentRef = null
    // Moving renumbers the task, so the response reports the new ref.
    if (flags.project) body.project = flags.project
    // Widening does not: the task keeps its home project and its ref, and only
    // starts appearing in the other projects' lists and boards too.
    if (flags['also-project'] !== undefined) body.alsoProjects = splitList(flags['also-project'])
    if (flags['duplicate-of']) {
      body.duplicateOf = flags['duplicate-of']
      body.resolutionKind = 'duplicate'
    }
    emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
  },

  async done() {
    return closeTask('done', 'fixed')
  },

  /**
   * Cancelling is closing too. Without this the CLI could reach five of the
   * six statuses, and a task dropped on purpose had to be edited by hand.
   */
  async cancel() {
    return closeTask('cancelled', 'wont-fix')
  },

  async note() {
    const ref = need(positional[0], 'usage: cairn note <ref> "<text>"')
    const note = await resolveValue(need(positional[1], 'a note body is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/notes`, { note, kind: flags.kind ?? 'note' }))
  },

  async log() {
    const ref = need(positional[0], 'usage: cairn log <ref>')
    const suffix = flags.kind ? `?kind=${flags.kind}` : ''
    const data = await request('GET', `/api/v1/tasks/${ref}/notes${suffix}`)
    emit(data, {
      rows: (d) =>
        d.map((n) => ({
          kind: n.kind,
          by: n.actor_id,
          at: n.created_at.slice(0, 16).replace('T', ' '),
          note: truncate(n.note, 90),
        })),
      columns: ['kind', 'by', 'at', 'note'],
    })
  },

  async comment() {
    const ref = need(positional[0], 'usage: cairn comment <ref> "<text>"')
    const content = await resolveValue(need(positional[1], 'a comment body is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/comments`, { content }))
  },

  async attach() {
    const ref = need(positional[0], 'usage: cairn attach <ref> <file>')
    const file = need(positional[1], 'a file path is required')
    const size = statSync(file).size
    process.stderr.write(`uploading ${basename(file)} (${size} bytes, ${mimeOf(file)})\n`)
    emit(await upload(`/api/v1/tasks/${ref}/attachments`, file))
  },

  async files() {
    const ref = need(positional[0], 'usage: cairn files <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/attachments`)
    emit(data, {
      rows: (d) =>
        d.map((a) => ({
          id: a.id,
          name: a.original_name,
          type: a.mime_type,
          bytes: a.size_bytes,
          by: a.actor_id,
        })),
      columns: ['id', 'name', 'type', 'bytes', 'by'],
    })
  },

  async children() {
    const ref = need(positional[0], 'usage: cairn children <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/children`)
    emit(data.children, {
      rows: (d) => d.map((t) => ({ ref: t.ref, status: t.status, title: truncate(t.title, 62) })),
      columns: ['ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv') {
      process.stderr.write(
        data.count === 0 ? 'no sub-tasks\n' : `${data.closed}/${data.count} closed\n`,
      )
    }
  },

  async history() {
    const ref = need(positional[0], 'usage: cairn history <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/activity`)
    emit(data, {
      rows: (d) =>
        d.map((e) => ({
          when: e.created_at.slice(0, 16).replace('T', ' '),
          who: e.actor_id,
          event: e.event,
          detail: summariseEvent(e.data),
        })),
      columns: ['when', 'who', 'event', 'detail'],
    })
    if (FORMAT === 'tsv' && data.length === 0) process.stderr.write('no recorded activity\n')
  },

  async deps() {
    const ref = need(positional[0], 'usage: cairn deps <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/dependencies`)
    emit(data, {
      rows: (d) =>
        d.map((r) => ({
          direction: r.direction,
          ref: r.ref,
          status: r.status,
          title: truncate(r.title, 62),
        })),
      columns: ['direction', 'ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv' && data.length === 0) {
      process.stderr.write('no dependencies\n')
    }
  },

  async blockedby() {
    const ref = need(positional[0], 'usage: cairn blockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    emit(await request('POST', `/api/v1/tasks/${ref}/dependencies`, {
      ref: other,
      direction: 'blocked-by',
    }))
  },

  async unblockedby() {
    const ref = need(positional[0], 'usage: cairn unblockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    const q = new URLSearchParams({ ref: other, direction: 'blocked-by' })
    emit(await request('DELETE', `/api/v1/tasks/${ref}/dependencies?${q}`))
  },

  async labels() {
    const sub = positional[0]
    if (sub === 'rename' || sub === 'merge') {
      const from = need(positional[1], 'usage: cairn labels rename <from> <to>')
      const to = need(positional[2], 'a new label name is required')
      emit(await request('PATCH', '/api/v1/labels', { from, to }))
      return
    }
    if (sub === 'remove' || sub === 'delete') {
      const from = need(positional[1], 'usage: cairn labels remove <label>')
      emit(await request('PATCH', '/api/v1/labels', { from, to: null }))
      return
    }
    if (sub) die(`unknown subcommand "${sub}" — expected rename or remove`)

    const data = await request('GET', '/api/v1/labels')
    emit(data, {
      rows: (d) => d.map((l) => ({ label: l.label, tasks: l.task_count })),
      columns: ['label', 'tasks'],
    })
  },

  async project() {
    const sub = need(positional[0], 'usage: cairn project <rename|delete> <KEY> [...]')
    const key = need(positional[1], 'a project key is required')

    if (sub === 'rename') {
      const title = need(positional[2], 'usage: cairn project rename <KEY> "<new title>"')
      emit(await request('PATCH', `/api/v1/projects/${key}`, { title }))
      return
    }
    if (sub === 'archive' || sub === 'restore') {
      emit(await request('PATCH', `/api/v1/projects/${key}`, {
        status: sub === 'archive' ? 'archived' : 'active',
      }))
      return
    }
    if (sub === 'delete') {
      // Deleting a project removes every task in it. The API demands the key
      // back as confirmation; require it here too rather than passing it
      // silently on the caller's behalf.
      if (flags.confirm !== key) {
        const info = await request('GET', `/api/v1/projects/${key}`)
        die(
          `This would delete ${info.task_count} task(s) in ${key} and everything ` +
            `attached to them, permanently.\nRe-run with --confirm ${key} if that is what you want.`,
        )
      }
      emit(await request('DELETE', `/api/v1/projects/${key}?confirm=${encodeURIComponent(key)}`))
      return
    }
    die(`unknown subcommand "${sub}" — expected rename, archive, restore or delete`)
  },

  async claim() {
    const ref = need(positional[0], 'usage: cairn claim <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/claim`, {}))
  },
  async beat() {
    emit(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: cairn beat <ref>')}/beat`, {}))
  },
  async release() {
    emit(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: cairn release <ref>')}/release`, {}))
  },
  async checkpoint() {
    const ref = need(positional[0], 'usage: cairn checkpoint <ref> --summary "<state>"')
    const summary = await resolveValue(need(flags.summary, 'a --summary is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/checkpoint`, { summary }))
  },
  async block() {
    const ref = need(positional[0], 'usage: cairn block <ref> --reason "<why>"')
    const reason = await resolveValue(need(flags.reason, 'a --reason is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason }))
  },
  async unblock() {
    const ref = need(positional[0], 'usage: cairn unblock <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason: null }))
  },

  // --- knowledge ---------------------------------------------------------

  async learn() {
    const title = need(positional[0], 'usage: cairn learn "<title>" --body -')
    const body = await resolveValue(flags.body ?? '')
    const payload = {
      title,
      body,
      labels: splitList(flags.label),
      projects: splitList(flags.project),
    }
    if (flags.entity) payload.entities = splitList(flags.entity)
    if (flags.slug) payload.slug = flags.slug
    if (flags.task) payload.sourceTaskRef = flags.task
    if (flags.verified) payload.verified = true

    const result = await request('POST', '/api/v1/knowledge', payload)
    emit(result)

    // Global is a real answer and often the right one, but it is also what you
    // get by forgetting. Five facts about one business ended up in front of
    // every project that way, and nothing said a word at the time.
    const scoped = (payload.projects ?? []).length + (payload.entities ?? []).length
    if (FORMAT === 'tsv' && scoped === 0) {
      process.stderr.write(
        'recorded as global — true everywhere. If it is not, add --project <KEY> or --entity <key> (cairn entities)\n',
      )
    }
  },

  async know() {
    const subject = positional[0]

    // A bare word that is a slug we hold is a fetch; anything else is a search.
    // Agents should not have to know which, and the distinction is cheap to make.
    if (subject && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(subject)) {
      const hit = await request('GET', `/api/v1/knowledge/${subject}`, undefined, { soft: true })
      if (hit) {
        if (FORMAT === 'json') return emit(hit)
        const k = hit
        process.stdout.write(`# ${k.title}\n`)
        if (k.labels?.length) process.stdout.write(`labels: ${k.labels.join(', ')}\n`)
        process.stdout.write(`scope: ${k.projects?.length ? k.projects.join(', ') : 'global'}\n\n`)
        process.stdout.write(`${k.body}\n`)
        return
      }
    }

    const params = new URLSearchParams()
    if (subject) {
      params.set('q', subject)
      params.set('kinds', 'knowledge')
      const data = await request('GET', `/api/v1/search?${params}`)
      return emit(data, {
        rows: (d) => d.results.map((r) => ({
          slug: r.ref,
          scope: r.project ?? 'global',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
        columns: ['slug', 'scope', 'tokens', 'title'],
      })
    }

    if (flags.project) params.set('project', flags.project)
    if (flags.label) params.set('label', flags.label)
    if (flags.limit) params.set('limit', flags.limit)
    if (flags.superseded) params.set('superseded', '1')
    const data = await request('GET', `/api/v1/knowledge?${params}`)
    emit(data, {
      rows: (d) => d.results.map((r) => ({
        slug: r.slug,
        // Where it applies, narrowest first: this project, else the groupings
        // it belongs to, else everywhere.
        scope: r.projects?.length
          ? r.projects.join(',')
          : r.entities?.length
            ? r.entities.join(',')
            : 'global',
        verified: r.verified ? 'yes' : '',
        tokens: `~${r.tokens}`,
        title: truncate(r.title, 70),
      })),
      columns: ['slug', 'scope', 'verified', 'tokens', 'title'],
    })
  },

  async unlearn() {
    const slug = need(positional[0], 'usage: cairn unlearn <slug> [--superseded-by <slug>]')
    if (flags['superseded-by']) {
      return emit(await request('PATCH', `/api/v1/knowledge/${slug}`, {
        supersededBy: flags['superseded-by'],
      }))
    }
    emit(await request('DELETE', `/api/v1/knowledge/${slug}`))
  },

  async relearn() {
    const slug = need(positional[0], 'usage: cairn relearn <slug> [--body -] [--title T]')
    const patch = {}
    if (flags.body !== undefined) patch.body = await resolveValue(flags.body)
    if (flags.title) patch.title = flags.title
    if (flags.label) patch.labels = splitList(flags.label)
    if (flags.project) patch.projects = splitList(flags.project)
    if (flags.entity !== undefined) patch.entities = splitList(flags.entity)
    if (flags.verified) patch.verified = true
    emit(await request('PATCH', `/api/v1/knowledge/${slug}`, patch))
  },

  async entities() {
    const verb = positional.shift()

    if (verb === 'add') {
      const key = need(positional[0], 'usage: cairn entities add <key> "<title>" [--project A,B]')
      return emit(
        await request('POST', '/api/v1/entities', {
          key,
          title: positional[1] ?? key,
          description: flags.description ?? '',
          projects: splitList(flags.project),
        }),
      )
    }

    if (verb === 'rename') {
      const key = need(positional[0], 'usage: cairn entities rename <key> [--key <new>] [--title "T"]')
      const patch = { key }
      if (flags.key) patch.newKey = flags.key
      if (flags.title) patch.title = flags.title
      if (flags.description) patch.description = flags.description
      return emit(await request('PATCH', '/api/v1/entities', patch))
    }

    if (verb === 'assign' || verb === 'unassign') {
      const key = need(positional[0], `usage: cairn entities ${verb} <key> --project A,B`)
      const projects = splitList(flags.project ?? positional[1])
      if (projects.length === 0) die('--project is required')
      return emit(
        await request('PATCH', '/api/v1/entities', {
          key,
          addProjects: verb === 'assign' ? projects : [],
          removeProjects: verb === 'unassign' ? projects : [],
        }),
      )
    }

    if (verb) die(`unknown entities verb "${verb}" — try: add, rename, assign, unassign`)

    const data = await request('GET', '/api/v1/entities')
    emit(data, {
      rows: (d) =>
        d.results.map((e) => ({
          entity: e.key,
          projects: e.projects.length,
          keys: truncate(e.projects.join(' '), 58),
          title: e.title,
        })),
      columns: ['entity', 'projects', 'keys', 'title'],
    })
  },

  // --- the briefing ------------------------------------------------------

  async context() {
    const cwd = flags.cwd ?? process.cwd()
    const params = new URLSearchParams()
    params.set('cwd', cwd)
    const project = flags.project ?? projectForDir(cwd)
    if (project) params.set('project', project)
    if (flags.file) params.set('file', flags.file)
    const data = await request('GET', `/api/v1/context?${params}`)
    if (FORMAT === 'json') return emit(data)
    process.stdout.write(renderContext(data, { fileOnly: Boolean(flags.file) }))
  },

  async map() {
    const dir = flags.dir ?? gitRoot(process.cwd()) ?? process.cwd()
    const key = positional[0]

    if (!key) {
      const map = readProjectMap()
      const rows = Object.entries(map).map(([path, k]) => ({ project: k, path }))
      return emit(
        { count: rows.length, here: projectForDir(process.cwd()) ?? '', rows },
        { rows: (d) => d.rows, columns: ['project', 'path'] },
      )
    }

    const map = readProjectMap()
    if (key === 'none') delete map[dir]
    else map[dir] = key.toUpperCase()

    mkdirSync(dirname(PROJECT_MAP_PATH), { recursive: true })
    writeFileSync(PROJECT_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`)
    emit({ path: dir, project: map[dir] ?? null })
  },

  async reconcile() {
    const body = { dryRun: Boolean(flags['dry-run']) }
    if (flags.older) body.olderThanMinutes = Number(flags.older)
    const data = await request('POST', '/api/v1/reconcile', body)
    emit(
      { count: data.released.length, ...data },
      {
        rows: (d) =>
          d.released.map((r) => ({
            ref: r.ref,
            held: `${r.heldForMinutes}m`,
            checkpoint: r.hadCheckpoint ? 'yes' : 'none',
          })),
        columns: ['ref', 'held', 'checkpoint'],
      },
    )
  },

  // --- the episodic record -----------------------------------------------

  async session() {
    const verb = positional.shift() ?? 'list'

    if (verb === 'end') {
      const payload = {
        externalId: need(flags.id, 'usage: cairn session end --id <session-id>'),
        platformSource: flags.platform ?? 'claude',
        cwd: flags.cwd ?? process.cwd(),
        files: splitList(flags.files),
        taskRefs: splitList(flags.tasks),
      }
      for (const [flag, field] of [
        ['project', 'project'], ['agent', 'agentId'], ['request', 'request'],
        ['learned', 'learned'], ['completed', 'completed'], ['next', 'nextSteps'],
        ['started', 'startedAt'],
      ]) {
        if (flags[flag] !== undefined) payload[field] = await resolveValue(flags[flag])
      }
      if (flags['tool-calls']) payload.toolCalls = Number(flags['tool-calls'])
      if (flags['no-checkpoint']) payload.checkpointHeld = false
      return emit(await request('POST', '/api/v1/sessions', payload))
    }

    if (verb === 'list') {
      const params = new URLSearchParams()
      if (flags.project) params.set('project', flags.project)
      if (flags.cwd) params.set('cwd', flags.cwd)
      if (flags.limit) params.set('limit', flags.limit)
      const data = await request('GET', `/api/v1/sessions?${params}`)
      return emit(data, {
        rows: (d) => d.results.map((r) => ({
          ended: (r.endedAt ?? '').slice(0, 16).replace('T', ' '),
          agent: r.agent ?? r.platform,
          files: r.files,
          tasks: (r.taskRefs ?? []).join(','),
          request: truncate(r.request ?? '', 60),
        })),
        columns: ['ended', 'agent', 'files', 'tasks', 'request'],
      })
    }

    die(`unknown session verb "${verb}" — try: end, list`)
  },
}

const command = positional.shift()
if (!command || flags.help || command === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (!commands[command]) {
  die(`unknown command "${command}"\n\nvalid: ${Object.keys(commands).sort().join(' ')}`)
}
await commands[command]()
