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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
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
const request = async (method, path, body) => {
  if (!KEY) die('CAIRN_API_KEY is not set (env, or ~/.cairn/env).')
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    die(`cannot reach ${BASE}: ${error.message}`)
  }

  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    die(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!payload.success) {
    // Surface the server's guidance verbatim — it names valid enum values and,
    // on a refused close, suggests a resolution. Swallowing that would turn a
    // useful round-trip into a wasted one.
    const extra = payload.suggestedResolution
      ? `\nsuggested: ${payload.suggestedResolution}`
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
      if (v.length) out[key] = v.join(',')
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

const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const HELP = `cairn — agent-first task tracker and shared memory

  ALWAYS START HERE
    cairn check "<subject>"        what has already been done or debugged

  read
    cairn list [--project K] [--status S] [--type T] [--label L] [--mine]
    cairn show <ref>               e.g. CAI-42
    cairn log <ref> [--kind K]     the work log
    cairn projects

  write
    cairn add "<title>" --project K [--type bug] [--priority high] [--body -]
    cairn update <ref> [--title T] [--status S] [--type T] [--priority P]
    cairn note <ref> "<text>" [--kind note|finding|decision|attempt|handoff]
    cairn comment <ref> "<text>"
    cairn done <ref> --resolution "<what was actually done>" [--kind fixed]
    cairn attach <ref> <file>      |   cairn files <ref>

  dependencies
    cairn deps <ref>                        what blocks this, and what it blocks
    cairn blockedby <ref> <other>           mark <ref> as blocked by <other>
    cairn unblockedby <ref> <other>         remove that link

  projects
    cairn project rename <KEY> "<title>"
    cairn project delete <KEY> --confirm <KEY>   deletes every task in it

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

const commands = {
  async check() {
    const q = need(positional[0], 'usage: cairn check "<subject>"')
    const params = new URLSearchParams({ q })
    if (flags.project) params.set('project', flags.project)
    if (flags.type) params.set('type', flags.type)
    const data = await request('GET', `/api/v1/search?${params}`)
    emit(data, {
      rows: (d) =>
        d.results.map((r) => ({
          ref: r.ref,
          status: r.status,
          type: r.type,
          answered: r.resolved ? 'yes' : '',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
      columns: ['ref', 'status', 'type', 'answered', 'tokens', 'title'],
    })
    if (FORMAT === 'tsv' && data.results.length === 0) {
      process.stderr.write('nothing found — this subject looks new\n')
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
    emit(await request('GET', `/api/v1/tasks/${ref}`))
  },

  async projects() {
    emit(await request('GET', '/api/v1/projects'))
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
    const dupes = await request('GET', `/api/v1/search?${new URLSearchParams({ q: probe })}`)
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
    emit(await request('POST', `/api/v1/projects/${project}/tasks`, body))
  },

  async update() {
    const ref = need(positional[0], 'usage: cairn update <ref> --status <s>')
    const body = {}
    if (flags.title) body.title = flags.title
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
  },

  async done() {
    const ref = need(positional[0], 'usage: cairn done <ref> --resolution "<what was done>"')
    const resolution = await resolveValue(
      need(flags.resolution, 'a --resolution is required: say what was actually done, and why'),
    )
    const body = { status: 'done', resolution }
    if (flags.kind) body.resolutionKind = flags.kind
    emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
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
    emit(await request('DELETE', `/api/v1/tasks/${ref}/dependencies`, {
      ref: other,
      direction: 'blocked-by',
    }))
  },

  async project() {
    const sub = need(positional[0], 'usage: cairn project <rename|delete> <KEY> [...]')
    const key = need(positional[1], 'a project key is required')

    if (sub === 'rename') {
      const title = need(positional[2], 'usage: cairn project rename <KEY> "<new title>"')
      emit(await request('PATCH', `/api/v1/projects/${key}`, { title }))
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
    die(`unknown subcommand "${sub}" — expected rename or delete`)
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
