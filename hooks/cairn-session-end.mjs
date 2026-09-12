#!/usr/bin/env node
/**
 * The write-without-being-asked half of Cairn's memory.
 *
 * Runs when a session ends and records what happened: the request, what was
 * learned, what got done, where it was left, which files were touched and
 * which tasks were worked. Then it checkpoints anything the agent is still
 * holding, so a claim nobody released stops looking like live work.
 *
 * Everything except four prose fields is read straight out of the transcript.
 * That split is the whole economics of this: the store this replaces spent a
 * model call on every tool call, ~1,114 billed turns a day, to produce a
 * corpus consulted a hundred times in seventeen days. One call per session is
 * roughly fifty a day, and the summary is the part that was worth keeping.
 *
 * If the summariser is unavailable or slow, the row is still written with the
 * deterministic half. A session with files and task refs and no prose is
 * useful; a session that was never recorded is not.
 */
import { spawn } from 'node:child_process'
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const CLI = process.env.CAIRN_CLI ?? 'cairn'
const MODEL = process.env.CAIRN_SUMMARY_MODEL ?? 'claude-haiku-4-5-20251001'
const SUMMARY_TIMEOUT_MS = Number(process.env.CAIRN_SUMMARY_TIMEOUT_MS ?? 60_000)

/** Enough transcript for a summary, bounded so cost cannot run away. */
const MAX_DIGEST_CHARS = 24_000

/**
 * The summariser is itself an agent session, and an agent session ends. Without
 * this guard the SessionEnd hook would summarise the summariser, forever.
 */
if (process.env.CAIRN_SUMMARISER === '1') process.exit(0)

const DRY_RUN = process.argv.includes('--dry-run')

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const TASK_REF = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

/**
 * Paths named inside a shell command.
 *
 * Structured tool inputs only cover Edit/Write/Read. A session that does its
 * file work through heredocs and sed -- which is most shell-heavy work --
 * recorded two files out of thirty until this existed.
 */
const SHELL_PATH = /(?:^|[\s'"=(])((?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|py|rb|go|rs|java|kt|swift|sh|yml|yaml|json|toml|md|css|scss|html))\b/g

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * A user turn that the human actually typed.
 *
 * Hook output, command stdout and system reminders all arrive as user turns,
 * and taking the first one blindly records "Use any available agents…" as the
 * request for every session on this machine.
 */
const isHumanTurn = (text) =>
  text &&
  !text.startsWith('<') &&
  // A runtime talking to itself is not a person asking for something.
  // OpenClaw prefixes every turn with its own context ("runtime context",
  // "assembled context"), and wakes the agent on a schedule to check it is
  // alive. Taking the first user turn recorded those as the request.
  !/^OpenClaw \w+ context for this turn/i.test(text) &&
  !/^Reply with exactly one word/i.test(text) &&
  !text.includes('<system-reminder>') &&
  !text.includes('<command-name>') &&
  !text.includes('<local-command') &&
  !text.startsWith('Caveat:')

const parseTranscript = async (path) => {
  const out = {
    cwd: null,
    branch: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    files: new Set(),
    refs: new Set(),
    actedOn: new Set(),
    toolCalls: 0,
    assistantText: [],
  }

  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity })

  for await (const line of stream) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.isSidechain) continue

    if (row.cwd && !out.cwd) out.cwd = row.cwd
    if (row.gitBranch && !out.branch) out.branch = row.gitBranch
    if (row.timestamp) {
      if (!out.startedAt) out.startedAt = row.timestamp
      out.endedAt = row.timestamp
    }

    const content = row.message?.content

    if (row.type === 'user') {
      const text = textOf(content).trim()
      if (isHumanTurn(text)) {
        out.prompts.push(text)
        // Only what the human asked about. Scraping every user turn would pull
        // refs out of tool output, which is how one session claimed to have
        // worked on seventy-seven tasks.
        for (const m of text.matchAll(TASK_REF)) out.refs.add(m[0])
      }
      continue
    }

    if (row.type !== 'assistant' || !Array.isArray(content)) continue

    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        // Narration is NOT scanned for refs. An agent that quotes a `cairn
        // check` index is discussing twenty tasks and working on one; recording
        // all twenty makes the file and task index answer "everything" to every
        // question, which is the same as knowing nothing.
        out.assistantText.push(block.text)
        continue
      }
      if (block?.type !== 'tool_use') continue

      out.toolCalls += 1
      const input = block.input ?? {}
      for (const key of PATH_KEYS) {
        if (typeof input[key] === 'string') out.files.add(input[key])
      }
      // Edits arrive as a batch on MultiEdit; the path is still file_path.
      // A command the agent actually ran is evidence of work, unlike prose.
      if (typeof input.command === 'string') {
        for (const m of input.command.matchAll(TASK_REF)) out.refs.add(m[0])
        for (const m of input.command.matchAll(SHELL_PATH)) out.files.add(m[1])

        // Strongest evidence there is: a cairn command naming a ref is this
        // session acting on that task, not mentioning it. When any exist, they
        // are the answer -- a long session quotes far more refs than it works.
        for (const line of input.command.split('\n')) {
          if (!/\bcairn\s+\w/.test(line)) continue
          for (const m of line.matchAll(TASK_REF)) out.actedOn.add(m[0])
        }
      }
    }
  }

  return out
}

/**
 * Codex keeps its own transcript, in its own shape.
 *
 * Its rollout files are JSONL like Claude's, and that is where the similarity
 * ends: every row is wrapped in `{type, payload}`, turns are `response_item`
 * rows carrying a `message`, tool calls are `custom_tool_call` rows whose
 * `input` is a JavaScript snippet rather than a structured object, and the cwd
 * lives on `turn_context`. Handing one of these to the Claude parser produces
 * a session with no prompts, no files and no tool calls -- which is filtered
 * out as "nothing happened", which is why zero Codex sessions were ever
 * recorded despite the hook being wired and firing.
 */
const parseCodexRollout = async (path) => {
  const out = {
    cwd: null,
    branch: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    files: new Set(),
    refs: new Set(),
    actedOn: new Set(),
    toolCalls: 0,
    assistantText: [],
  }

  const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity })

  for await (const line of stream) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    if (row.timestamp) {
      if (!out.startedAt) out.startedAt = row.timestamp
      out.endedAt = row.timestamp
    }

    const p = row.payload
    if (!p || typeof p !== 'object') continue

    if (row.type === 'turn_context' && typeof p.cwd === 'string' && !out.cwd) {
      out.cwd = p.cwd
      continue
    }

    if (row.type !== 'response_item') continue

    if (p.type === 'message') {
      // `developer` is the skills and instructions preamble, not a person.
      const text = codexText(p.content).trim()
      if (p.role === 'user') {
        if (isHumanTurn(text)) {
          out.prompts.push(text)
          for (const m of text.matchAll(TASK_REF)) out.refs.add(m[0])
        }
      } else if (p.role === 'assistant' && text) {
        out.assistantText.push(text)
      }
      continue
    }

    // Codex under OpenClaw emits `function_call` with JSON `arguments`;
    // Codex on its own emits `custom_tool_call` with a JS snippet. Reading
    // only the second recorded OpenClaw sessions with zero tool calls, which
    // looks exactly like a session where nothing happened.
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      out.toolCalls += 1
      // The whole snippet, not a parsed command: Codex wraps the command in a
      // `tools.exec_command({...})` call with its own quoting, and the regexes
      // want the text either way.
      const input =
        typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : ''
      if (!input) continue
      for (const m of input.matchAll(TASK_REF)) out.refs.add(m[0])
      for (const m of input.matchAll(SHELL_PATH)) out.files.add(m[1])
      for (const part of input.split(/\\n|\n/)) {
        if (!/\bcairn\s+\w/.test(part)) continue
        for (const m of part.matchAll(TASK_REF)) out.actedOn.add(m[0])
      }
    }
  }

  return out
}

/** Codex content blocks are `input_text` / `output_text`, not `text`. */
const codexText = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => typeof b?.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * The newest Codex rollout, for when the hook payload does not name one.
 *
 * Codex's Stop hook does not hand over a transcript path the way Claude's
 * SessionEnd does, and the hook simply returned when it found none. The files
 * are laid out as sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl, and
 * the id in the filename is the session id, so the newest one touched in the
 * last few hours is the session that just stopped.
 */
const RECENT_MS = 6 * 60 * 60 * 1000

/**
 * The session id carried by the filename.
 *
 * Codex writes `rollout-<timestamp>-<uuid>.jsonl`; Claude names the file after
 * the session itself. Either way the id is there, which is what makes
 * `--dry-run <path>` work for both without a hook payload to read it from.
 */
const idFromRollout = (path) => {
  const name = path.split('/').pop() ?? ''
  return (
    /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1] ??
    /^([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1] ??
    null
  )
}

const newestRollout = () => {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  let best = null
  try {
    for (const entry of readdirSync(root, { recursive: true })) {
      const name = String(entry)
      if (!name.endsWith('.jsonl')) continue
      const path = join(root, name)
      let mtime
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (Date.now() - mtime > RECENT_MS) continue
      if (!best || mtime > best.mtime) {
        const id = idFromRollout(name)
        if (id) best = { path, id, mtime }
      }
    }
  } catch {
    return null
  }
  return best
}

/**
 * Codex wraps every row in `{type, payload}`; Claude does not.
 *
 * Read generously and drop the last line, which the slice may have cut in
 * half. Codex's opening `session_meta` row carries the whole instructions
 * preamble and runs to tens of kilobytes on its own, so a small window plus a
 * single JSON.parse decided every Codex transcript was a Claude one.
 */
const CODEX_ROWS = new Set(['session_meta', 'response_item', 'turn_context', 'event_msg'])

const looksLikeCodex = (path) => {
  try {
    const lines = readFileSync(path, 'utf8').slice(0, 512_000).split('\n').slice(0, -1)
    for (const line of lines) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (CODEX_ROWS.has(row?.type)) return true
      if (row?.type === 'user' || row?.type === 'assistant') return false
    }
  } catch {
    return false
  }
  return false
}

/**
 * Files worth recording: source, not scratch.
 *
 * Recording every path a session glanced at would make the file index answer
 * "who touched this" with "everyone", which is the same as not knowing.
 */
const IGNORED = /(^\/tmp\/|\/node_modules\/|\/\.git\/|\/scratchpad\/|\.lock$|\.log$)/

const keepFiles = (files, cwd) =>
  [...files]
    .filter((f) => !IGNORED.test(f))
    .map((f) => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f))
    .slice(0, 200)

const buildDigest = (t) => {
  const parts = []
  if (t.prompts.length) parts.push(`# What was asked\n${t.prompts.join('\n\n---\n\n').slice(0, 6000)}`)

  // The tail of the assistant's own narration is where conclusions live; the
  // head is where the shape of the work is stated. Both beat the middle.
  const narration = t.assistantText.join('\n\n')
  if (narration) {
    const head = narration.slice(0, 6000)
    const tail = narration.length > 12_000 ? narration.slice(-10_000) : ''
    parts.push(`# What the agent said\n${head}${tail ? `\n\n[...]\n\n${tail}` : ''}`)
  }

  return parts.join('\n\n').slice(0, MAX_DIGEST_CHARS)
}

const PROMPT = `You are writing one entry in an engineering memory that other agents read months later.

Return ONLY a JSON object, no prose around it, with exactly these keys:
  "request"    one sentence: what was actually asked for
  "learned"    what is now known that was not before - findings, causes, measurements,
               and dead ends. Dead ends matter as much as fixes. Empty string if nothing.
  "completed"  what actually landed. Empty string if nothing did.
  "next_steps" what the next session should pick up, verbatim enough to act on.
               Empty string if the work is finished.

Be specific and concrete: name files, numbers, error codes, task refs. Do not
congratulate, do not summarise the summary, do not invent anything that is not
in the transcript below.`

const summarise = (digest) =>
  new Promise((resolve) => {
    if (!digest.trim()) return resolve(null)

    let out = ''
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }

    const child = spawn(
      process.env.CAIRN_SUMMARY_CLI ?? 'claude',
      ['-p', '--model', MODEL, '--output-format', 'text'],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, CAIRN_SUMMARISER: '1' },
      },
    )

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(null)
    }, SUMMARY_TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const match = out.match(/\{[\s\S]*\}/)
      if (!match) return done(null)
      try {
        done(JSON.parse(match[0]))
      } catch {
        done(null)
      }
    })

    // A failed spawn leaves stdin null, and writing to it throws synchronously
    // -- which, inside a hook whose whole contract is never to interfere, would
    // take down the recorder over an unavailable summariser.
    try {
      child.stdin.end(`${PROMPT}\n\n---\n\n${digest}`)
    } catch {
      clearTimeout(timer)
      done(null)
    }
  })

const DEBUG = process.env.CAIRN_HOOK_DEBUG === '1'

const post = (args) =>
  new Promise((resolve) => {
    const child = spawn(CLI, args, {
      stdio: ['ignore', DEBUG ? 'inherit' : 'ignore', DEBUG ? 'inherit' : 'ignore'],
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })

const record = async (payload) => {
  let transcriptPath = payload.transcript_path
  let sessionId = payload.session_id

  // Claude's SessionEnd names the transcript. Codex's Stop does not, so find
  // the rollout it just finished writing.
  if (!transcriptPath) {
    const rollout = newestRollout()
    if (!rollout) return
    transcriptPath = rollout.path
    sessionId = sessionId ?? rollout.id
  }
  // A runtime that names the transcript but not the session still has the id:
  // Codex puts it in the filename.
  sessionId = sessionId ?? idFromRollout(transcriptPath)
  if (!sessionId) return

  // Sniffed rather than taken from CAIRN_PLATFORM: the format is a fact about
  // the file, and a mislabelled platform should not silently produce an empty
  // session.
  const parse = looksLikeCodex(transcriptPath) ? parseCodexRollout : parseTranscript

  const t = await parse(transcriptPath).catch(() => null)
  if (!t) return

  // `--dry-run <path>` parses and reports, writing nothing. Without it the
  // only way to find out whether a runtime's transcript is being read was to
  // end a session and go looking for a row that might never appear -- which is
  // how Codex went two days recording nothing.
  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        {
          transcript: transcriptPath,
          format: parse === parseCodexRollout ? 'codex' : 'claude',
          sessionId,
          cwd: payload.cwd ?? t.cwd,
          prompts: t.prompts.length,
          toolCalls: t.toolCalls,
          files: keepFiles(t.files, payload.cwd ?? t.cwd).length,
          refs: [...(t.actedOn.size > 0 ? t.actedOn : t.refs)].slice(0, 12),
          firstPrompt: t.prompts[0]?.slice(0, 120) ?? null,
        },
        null,
        2,
      ),
    )
    return
  }

  // Nothing happened. A row saying so is noise in every later search.
  //
  // Tool calls alone are not evidence of work: OpenClaw wakes on a schedule,
  // finds nothing to do and answers HEARTBEAT_OK, which is several tool calls
  // and no session anybody will ever want to read. Something a person asked
  // for, a file touched, or a task worked — one of those has to be true.
  if (t.prompts.length === 0 && t.files.size === 0 && t.refs.size === 0) return

  const cwd = payload.cwd ?? t.cwd
  const files = keepFiles(t.files, cwd)
  const summary = (await summarise(buildDigest(t))) ?? {}

  const args = [
    'session',
    'end',
    '--id',
    sessionId,
    '--platform',
    process.env.CAIRN_PLATFORM ?? 'claude',
    '--cwd',
    cwd ?? process.cwd(),
    '--tool-calls',
    String(t.toolCalls),
  ]

  if (t.startedAt) args.push('--started', t.startedAt)
  if (files.length) args.push('--files', files.join(','))
  const refs = t.actedOn.size > 0 ? t.actedOn : t.refs
  if (refs.size) args.push('--tasks', [...refs].slice(0, 400).join(','))
  if (process.env.CAIRN_AGENT) args.push('--agent', process.env.CAIRN_AGENT)

  const request = summary.request || t.prompts[0]?.slice(0, 500)
  if (request) args.push('--request', request)
  for (const [key, flag] of [
    ['learned', '--learned'],
    ['completed', '--completed'],
    ['next_steps', '--next'],
  ]) {
    if (summary[key]) args.push(flag, String(summary[key]).slice(0, 8000))
  }

  await post(args)
}

/**
 * Sessions a runtime never told us about.
 *
 * OpenClaw has no session-end event of any kind -- it IS Codex, pointed at a
 * CODEX_HOME of its own, so it leaves rollouts behind and says nothing. A
 * schedule sweeping that directory is the only way to record what it did.
 *
 * Two rules make a sweep safe where a hook is not. A rollout touched in the
 * last few minutes may still be being written, so it is left for the next
 * pass; and every id recorded is remembered, because the summary costs a model
 * call and re-reading yesterday's sessions hourly would pay for it again and
 * again for nothing.
 */
const SETTLED_MS = Number(process.env.CAIRN_ROLLOUT_SETTLE_MIN ?? 10) * 60_000
const SEEN_PATH = join(homedir(), '.cairn', 'recorded-rollouts')
const SEEN_CAP = 2000

const readSeen = () => {
  try {
    return new Set(readFileSync(SEEN_PATH, 'utf8').split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

const rememberSeen = (seen) => {
  try {
    mkdirSync(dirname(SEEN_PATH), { recursive: true })
    writeFileSync(SEEN_PATH, `${[...seen].slice(-SEEN_CAP).join('\n')}\n`)
  } catch {
    // Losing the marker costs a repeated summary, not a wrong one.
  }
}

const scan = async (root, windowHours) => {
  const seen = readSeen()
  const cutoff = Date.now() - windowHours * 3_600_000
  const found = []

  try {
    for (const entry of readdirSync(root, { recursive: true })) {
      const name = String(entry)
      if (!name.endsWith('.jsonl')) continue
      const path = join(root, name)
      const id = idFromRollout(name)
      if (!id || seen.has(id)) continue
      let mtime
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (mtime < cutoff) continue
      if (Date.now() - mtime < SETTLED_MS) continue
      found.push({ path, id, mtime })
    }
  } catch (error) {
    if (DEBUG) console.error('[cairn-session-end] scan', error)
    return
  }

  found.sort((a, b) => a.mtime - b.mtime)
  for (const rollout of found) {
    await record({ transcript_path: rollout.path, session_id: rollout.id })
    seen.add(rollout.id)
  }
  rememberSeen(seen)
  console.log(`recorded ${found.length} session(s) from ${root}`)
}

const main = async () => {
  const scanRoot = arg('--scan')
  if (scanRoot) return scan(scanRoot, Number(arg('--window-hours') ?? 24))

  const dryIndex = process.argv.indexOf('--dry-run')
  return record(DRY_RUN ? { transcript_path: process.argv[dryIndex + 1] } : await readStdin())
}

main().catch((error) => {
  // Silent by default, on purpose: a memory system must never be the reason a
  // session fails to close. CAIRN_HOOK_DEBUG=1 when that silence is the problem.
  if (DEBUG) console.error('[cairn-session-end]', error)
})
