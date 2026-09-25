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
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
 *
 * Every summariser, not only this one. Quarry runs the same kind of hook with
 * its own `claude -p` child and marks it QUARRY_SUMMARISER; checking only our
 * own flag recorded 37 of Quarry's child runs as Cairn sessions, each wearing
 * a copy of its parent's summary (CAIRN-287). AGENT_MEMORY_SUMMARISER is the
 * shared name either tool can set.
 */
const SUMMARISER_FLAGS = ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']
if (SUMMARISER_FLAGS.some((name) => process.env[name] === '1')) process.exit(0)

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
/**
 * The prompts a schedule writes, as opposed to a person.
 *
 * Kept separate from the rest of `isHumanTurn` because the answer is worth
 * recording: these are not merely "not a person", they are specifically a
 * scheduled run, and the session row should say so. The page used to work this
 * out by testing the stored request — which stopped being possible the moment
 * the hook, rightly, stopped storing it.
 *
 * ONLY the cron marker. The first version of this also matched OpenClaw's
 * per-turn envelope ("OpenClaw <agent> context for this turn"), which wraps
 * every turn including a real instruction from a person — so a re-sweep filed
 * 33 sessions as scheduled where 9 were, and hid real work behind a toggle
 * meant for machinery. `isHumanTurn` is still right to refuse those as a
 * request; they are simply not evidence of a schedule.
 */
const SCHEDULED_PROMPT = /^\[cron:[0-9a-f-]{8,}/i

/**
 * The opening line of a summariser's prompt — ours ("an engineering memory")
 * or Quarry's ("a sales memory").
 *
 * An environment flag is the first defence and it does not always survive: a
 * CAIRN_SUMMARY_CLI wrapper that drops to another account through sudo resets
 * the environment, and the child's own SessionEnd then records it. The prompt
 * survives everything, so a transcript that opens with it is a summariser run
 * whatever the environment said.
 */
const SUMMARISER_PROMPT = /^You are writing one entry in an? [\w -]*memory\b/i

/**
 * Wrappers a runtime puts around what a person typed. The text inside is the
 * person; the wrapper is not. OpenClaw began prefixing turns with
 * `[OpenClaw conversation info: sender={…}]` on 09-23, and six sessions
 * recorded that line as their request.
 */
const OPENCLAW_WRAPPER = /^\[OpenClaw conversation info:/i

const unwrap = (text) => {
  if (!OPENCLAW_WRAPPER.test(text)) return text
  // `sender={…}]` closes it; a wrapper in some other shape is its first line.
  const closed = /^\[OpenClaw conversation info:[\s\S]*?\}\]/i.exec(text)
  const rest = closed ? text.slice(closed[0].length) : text.split('\n').slice(1).join('\n')
  return rest.trim()
}

/**
 * Turns that are a person but not a request. Kept out of `request` only —
 * they still count as a person having been there.
 */
const TRIVIAL = /^(?:hi|hello|hey|yo|ok(?:ay)?|thanks?(?: you)?|merci|salut|bonjour|continue|go(?: on| ahead)?|yes|no|y|n)[\s.!?]*$/i

/**
 * A slash command arrives as `<command-name>` markup and is refused below, but
 * what was typed after it is the request: `/fix the login redirect` is a
 * person asking for something. The expansion that follows is the skill, not
 * them, and is marked isMeta.
 */
const commandArgs = (text) => {
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args && args.split(/\s+/).length >= 3 ? args : null
}

const isHumanTurn = (text) =>
  text &&
  !text.startsWith('<') &&
  // A runtime talking to itself is not a person asking for something, and
  // the session list had become mostly machinery talking to machinery: the
  // same cron prompt every three hours, context blobs of raw JSON, and the
  // instruction file being reloaded. None of it is a session anybody will ever
  // want to read, and each one crowded out the few that were.
  !/^OpenClaw \w+ context for this turn/i.test(text) &&
  !/^Reply with exactly one word/i.test(text) &&
  !/^\[cron:[0-9a-f-]{8,}/i.test(text) &&
  !/^Conversation info:/i.test(text) &&
  !OPENCLAW_WRAPPER.test(text) &&
  !/^#+\s*AGENTS\.md instructions/i.test(text) &&
  !text.startsWith('<INSTRUCTIONS>') &&
  !text.includes('<system-reminder>') &&
  !text.includes('<command-name>') &&
  !text.includes('<local-command') &&
  !text.startsWith('Caveat:') &&
  !SUMMARISER_PROMPT.test(text)

/** What a person typed in this turn, or null when it was machinery. */
const humanText = (raw) => {
  const text = unwrap(raw)
  if (isHumanTurn(text)) return text
  return raw.includes('<command-name>') ? commandArgs(raw) : null
}

const parseTranscript = async (path) => {
  const out = {
    cwd: null,
    branch: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    scheduled: false,
    summariser: false,
    files: new Set(),
    refs: new Set(),
    actedOn: new Set(),
    toolCalls: 0,
    assistantText: [],
  }
  let spoke = false

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
      // A skill's expansion, a caveat: written by the runtime into a user turn.
      if (row.isMeta) continue
      const raw = textOf(content).trim()
      if (!raw) continue
      if (SCHEDULED_PROMPT.test(raw)) out.scheduled = true
      const text = humanText(raw)
      // Before any person spoke, not merely first: a SessionStart hook's
      // output can land ahead of the prompt.
      if (!spoke && SUMMARISER_PROMPT.test(raw)) out.summariser = true
      if (text || SUMMARISER_PROMPT.test(raw)) spoke = true
      if (text) {
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
    scheduled: false,
    summariser: false,
    files: new Set(),
    refs: new Set(),
    actedOn: new Set(),
    toolCalls: 0,
    assistantText: [],
  }
  let spoke = false

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
      if (p.role === 'user' && text) {
        if (SCHEDULED_PROMPT.test(text)) out.scheduled = true
        const human = humanText(text)
        if (!spoke && SUMMARISER_PROMPT.test(text)) out.summariser = true
        if (human || SUMMARISER_PROMPT.test(text)) spoke = true
        if (human) {
          out.prompts.push(human)
          for (const m of human.matchAll(TASK_REF)) out.refs.add(m[0])
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
/**
 * The refs this session actually wrote to, from the CLI's own breadcrumbs.
 *
 * Recovering refs by regex over a transcript is a guess, and it was wrong in a
 * way that mattered: a dry run returned CAI-42 and LEGACY-1164, refs out of
 * documentation examples, rather than the tasks worked on. Session -> task
 * links feed search, and a session linked to everything answers yes to
 * everything.
 *
 * The CLI records `{t, ref, verb, cwd, agent}` per accepted write, so this is
 * evidence instead. Matched on time because a session id is not knowable at
 * write time across Codex, OpenClaw and Claude alike, but every runtime shares
 * a clock and the transcript gives both ends of the window.
 */
const ACTED_PATH = join(homedir(), '.cairn', 'acted.jsonl')

/** A write can land after the last transcript line, never meaningfully before. */
const ACTED_SLACK_MS = 2 * 60 * 1000

const actedFromBreadcrumbs = ({ startedAt, endedAt, cwd, sessionId }) => {
  if (!startedAt) return null
  let lines
  try {
    lines = readFileSync(ACTED_PATH, 'utf8').trim().split('\n')
  } catch {
    return null // no CLI breadcrumbs on this machine, or none yet
  }

  const from = Date.parse(startedAt)
  const to = (endedAt ? Date.parse(endedAt) : Date.now()) + ACTED_SLACK_MS
  if (Number.isNaN(from)) return null

  const inWindow = []
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue // a torn last line, or a file written by something else
    }
    if (!row?.ref || !row?.t) continue
    const at = Date.parse(row.t)
    if (Number.isNaN(at) || at < from || at > to) continue
    inWindow.push(row)
  }
  if (inWindow.length === 0) return null

  // Several sessions share the clock, so the window alone picks up a sibling's
  // writes. This used to narrow by directory and, when nothing matched, fall
  // back to the WHOLE WINDOW -- which is how a knowledge-map task ended up
  // carrying a progress report about three unrelated pull requests.
  //
  // The session id is exact where it exists, so use it and stop. A row with no
  // session came from a runtime that cannot name itself, and excluding those
  // would throw away every breadcrumb Codex and OpenClaw write, so they stay
  // and the directory still separates them.
  if (sessionId) {
    const mine = inWindow.filter((row) => row.session === sessionId)
    const unnamed = inWindow.filter((row) => !row.session)
    const byDirectory = cwd ? unnamed.filter((row) => row.cwd === cwd) : unnamed
    // Deliberately no fallback to the whole window. If nothing in it belongs
    // to this session, this session wrote nothing through the CLI, and saying
    // so is the honest answer. A session row with no task links is a small
    // loss; a session row attached to somebody else's task is a wrong record
    // that later readers believe.
    return new Set([...mine, ...byDirectory].map((row) => row.ref))
  }

  // No session to filter on. Directory, then the window, as before -- this is
  // the path Codex and OpenClaw take and it is no worse than it was.
  const here = cwd ? inWindow.filter((row) => row.cwd === cwd) : []
  const chosen = here.length > 0 ? here : inWindow
  return new Set(chosen.map((row) => row.ref))
}

/**
 * Breadcrumbs first, then refs seen beside a `cairn` command in the transcript.
 *
 * BARE PROSE MENTIONS USED TO BE THE LAST RESORT AND ARE NOT ANY MORE. The
 * reasoning was that a guessed link beats no link; the counter-example is a
 * session that spent an hour discussing four tasks purely to coordinate with
 * another session, while working on something else entirely. Under the old
 * rule it would have been recorded as having worked all four, and those links
 * drive the end-of-session checkpoint -- so the tasks would carry a progress
 * report about work nobody did to them. CAIRN-209 has one.
 *
 * Discussing a task is not working on it. The remaining fallback is refs that
 * appeared on a line with a `cairn` command, which is observed action rather
 * than conversation.
 */
const chooseRefs = (t, cwd, sessionId) =>
  actedFromBreadcrumbs({ startedAt: t.startedAt, endedAt: t.endedAt, cwd, sessionId }) ??
  t.actedOn

/** Which of the two answered, so a dry run says how much to trust it. */
const refSource = (t, cwd, sessionId) =>
  actedFromBreadcrumbs({ startedAt: t.startedAt, endedAt: t.endedAt, cwd, sessionId })
    ? 'breadcrumbs'
    : 'cairn-commands'

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

/**
 * Head and tail, never the middle.
 *
 * A long transcript states the shape of the work at the top and its
 * conclusions at the bottom. The middle is the fifteen tangents.
 */
const headAndTail = (text, headChars, tailChars) => {
  if (text.length <= headChars + tailChars) return text
  return `${text.slice(0, headChars)}\n\n[...]\n\n${text.slice(-tailChars)}`
}

const buildDigest = (t) => {
  const parts = []

  // The prompts used to be head-only, and that was fine while a session was an
  // afternoon. Since the recorder also runs at compaction, the normal session
  // being summarised is a long one: this file was first written up from a
  // transcript two days old, and the recorded request was the first hour's ask
  // -- true on the Friday, and no longer what the session was about. The last
  // prompts say what it turned into; the first say what it set out to do.
  if (t.prompts.length) {
    parts.push(`# What was asked\n${headAndTail(t.prompts.join('\n\n---\n\n'), 3500, 4500)}`)
  }

  const narration = t.assistantText.join('\n\n')
  if (narration) parts.push(`# What the agent said\n${headAndTail(narration, 6000, 10_000)}`)

  return parts.join('\n\n').slice(0, MAX_DIGEST_CHARS)
}

const PROMPT = `You are writing one entry in an engineering memory that other agents read months later.

Return ONLY a JSON object, no prose around it, with exactly these keys:
  "request"    one sentence: what was actually asked for. A long session often
               carries several unrelated requests -- the digest below is its
               beginning and its end, with the middle cut -- so cover the span
               rather than only the first thing in it.
  "learned"    what is now known that was not before - findings, causes, measurements,
               and dead ends. Dead ends matter as much as fixes. Empty string if nothing.
  "completed"  what actually landed. Empty string if nothing did.
  "next_steps" what the next session should pick up, verbatim enough to act on.
               Empty string if the work is finished.

Be specific and concrete: name files, numbers, error codes, task refs. Do not
congratulate, do not summarise the summary, do not invent anything that is not
in the transcript below.`

/**
 * The summariser is the only part of this that costs money, and Codex calls it
 * on every turn.
 *
 * Codex has no SessionEnd, so `install-hooks.mjs` wires the recorder to Stop,
 * which fires at the end of each assistant turn. `record()` then summarised
 * unconditionally: a forty-turn session made forty model calls, each with up
 * to 24 KB of transcript, to write and rewrite one row. The row was always
 * right -- `cairn session end` upserts on (platform, id) -- but the calls
 * multiplied, which is the exact economics the comment at the top of this file
 * says the design escaped. Nobody chose one call per turn; it arrived because
 * Stop was the only event Codex had.
 *
 * Two rules, and between them they cost nothing in quality:
 *
 *   - If the digest is byte-for-byte what was last summarised for this
 *     session, the model would return what it returned before. Reuse it.
 *   - Otherwise, if the last call for this session was under
 *     CAIRN_SUMMARY_MIN_INTERVAL_MS ago, reuse it anyway. The deterministic
 *     half -- files, task refs, counts -- is still written fresh every time,
 *     and a row with slightly older prose beats a row rewritten forty times.
 *
 * Reuse rather than omission on purpose: leaving the prose out would blank
 * fields that already held something true.
 *
 * The digest is capped at MAX_DIGEST_CHARS, so its LENGTH stops changing once
 * a session is long. Its CONTENT does not -- the tail moves -- so this hashes
 * rather than measures.
 */
const SUMMARY_STATE = join(homedir(), '.cairn', 'summaries.json')
const MIN_INTERVAL_MS = Number(process.env.CAIRN_SUMMARY_MIN_INTERVAL_MS ?? 600_000)
/** Enough that one machine's sessions do not accumulate without bound. */
const KEEP_SUMMARIES = 50

const readSummaryState = () => {
  try {
    const parsed = JSON.parse(readFileSync(SUMMARY_STATE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const rememberSummary = (sessionId, digestHash, summary) => {
  try {
    const state = readSummaryState()
    state[sessionId] = { at: Date.now(), digestHash, summary }
    const kept = Object.entries(state)
      .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, KEEP_SUMMARIES)
    mkdirSync(dirname(SUMMARY_STATE), { recursive: true })
    writeFileSync(SUMMARY_STATE, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // A stamp we cannot write costs one extra model call next time, which is
    // not worth failing a session record over.
  }
}

/**
 * The summary for this digest, from the model or from last time.
 *
 * Returns the summary, whether it is new, and — when the model was asked and
 * gave nothing usable — why, so the caller can log it and queue a retry.
 */
const summaryFor = async (sessionId, digest) => {
  const digestHash = createHash('sha256').update(digest).digest('hex')
  const previous = sessionId ? readSummaryState()[sessionId] : null

  if (previous?.summary) {
    if (previous.digestHash === digestHash) return { summary: previous.summary, fresh: false }
    if (Date.now() - (previous.at ?? 0) < MIN_INTERVAL_MS) {
      return { summary: previous.summary, fresh: false }
    }
  }

  const { summary, error } = await summarise(digest)
  if (summary && sessionId) rememberSummary(sessionId, digestHash, summary)
  return { summary, fresh: true, error }
}

/**
 * Where a summariser failure goes, with what the summariser said.
 *
 * Every failure used to be swallowed, stderr included, and the summariser was
 * down on both hosts for about forty hours on 09-23 without a line anywhere
 * saying so (CAIRN-287). Still never fatal — this is a hook — but no longer
 * silent: `tail ~/.cairn/summariser.log` answers "why has nothing got prose".
 */
const SUMMARISER_LOG = join(homedir(), '.cairn', 'summariser.log')
const LOG_MAX_BYTES = 256 * 1024

const logSummariser = (line) => {
  try {
    mkdirSync(dirname(SUMMARISER_LOG), { recursive: true })
    try {
      if (statSync(SUMMARISER_LOG).size > LOG_MAX_BYTES) {
        const kept = readFileSync(SUMMARISER_LOG, 'utf8').slice(-LOG_MAX_BYTES / 2)
        writeFileSync(SUMMARISER_LOG, kept.slice(kept.indexOf('\n') + 1))
      }
    } catch {
      // no log yet
    }
    appendFileSync(SUMMARISER_LOG, `${new Date().toISOString()} ${line.replace(/\s+/g, ' ').trim()}\n`)
  } catch {
    // A log we cannot write must not cost the session row.
  }
}

/**
 * Asked with no session persistence and from a scratch directory.
 *
 * `claude -p` saves its transcript like any session, under the project it was
 * run from, so the next `claude --continue` there resumed the SUMMARISER and
 * the person's real work was recorded under the summariser's prompt (af1af02c,
 * 293 tool calls). `--no-session-persistence` stops the save; the scratch cwd
 * keeps a CLI too old for the flag from saving into the project. Every
 * summariser flag is set, so Quarry's hook skips this child the way this hook
 * skips Quarry's.
 */
const NO_PERSISTENCE = '--no-session-persistence'

const runSummariser = (input, persistFlag) =>
  new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }

    const args = ['-p', '--model', MODEL, '--output-format', 'text']
    if (persistFlag) args.push(NO_PERSISTENCE)
    const env = { ...process.env }
    for (const name of SUMMARISER_FLAGS) env[name] = '1'

    let child
    try {
      child = spawn(process.env.CAIRN_SUMMARY_CLI ?? 'claude', args, {
        cwd: tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
    } catch (error) {
      return done({ out, err, error: `spawn failed: ${error.message}` })
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ out, err, error: `timed out after ${SUMMARY_TIMEOUT_MS}ms` })
    }, SUMMARY_TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      if (err.length < 8000) err += d
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ out, err, error: `spawn failed: ${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ out, err, code })
    })

    // A failed spawn leaves stdin null, and writing to it throws synchronously
    // -- which, inside a hook whose whole contract is never to interfere, would
    // take down the recorder over an unavailable summariser.
    try {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } catch {
      clearTimeout(timer)
      done({ out, err, error: 'could not write the prompt' })
    }
  })

const tail = (text, n) => text.trim().slice(-n)

/** `{summary}` or `{error}`, never a throw. */
const summarise = async (digest) => {
  if (!digest.trim()) return { summary: null }
  const input = `${PROMPT}\n\n---\n\n${digest}`

  let run = await runSummariser(input, true)
  // A CLI that predates the flag refuses the whole call; ask again without it
  // rather than lose every summary to an upgrade nobody has run yet.
  if (
    run.code &&
    new RegExp(`(unknown|unrecognized|invalid).*${NO_PERSISTENCE}|${NO_PERSISTENCE}.*(unknown|unrecognized)`, 'i')
      .test(`${run.err}\n${run.out}`)
  ) {
    run = await runSummariser(input, false)
  }

  if (run.error) return { summary: null, error: run.error }
  if (run.code) {
    return { summary: null, error: `exit ${run.code}: ${tail(run.err, 500) || tail(run.out, 300) || 'no output'}` }
  }
  const match = run.out.match(/\{[\s\S]*\}/)
  if (!match) return { summary: null, error: `no JSON in output: ${tail(run.out, 300) || tail(run.err, 300) || 'empty'}` }
  try {
    return { summary: JSON.parse(match[0]) }
  } catch {
    return { summary: null, error: `unparseable JSON: ${match[0].slice(0, 300)}` }
  }
}

/**
 * Sessions recorded without prose, to be summarised again once the
 * summariser answers.
 *
 * The row is still written at once with its deterministic half — that rule
 * stands — and its missing prose is what `cairn vitals` counts. What was
 * missing was any way back: nothing retried, so forty hours of sessions kept
 * their raw first prompt as a headline for good. This queue holds the
 * transcript path, which only this machine can read, and the next run of the
 * hook that reaches a working summariser re-summarises a few of them.
 *
 * Bounded every way it can grow: RETRY_BATCH per run, RETRY_MAX_TRIES per
 * session, RETRY_WINDOW_MS of age, and never sooner than RETRY_SPACING_MS
 * after the last attempt — Codex runs this hook every turn.
 */
const UNSUMMARISED_PATH = join(homedir(), '.cairn', 'unsummarised.json')
const RETRY_BATCH = Number(process.env.CAIRN_SUMMARY_RETRY_BATCH ?? 2)
const RETRY_MAX_TRIES = 4
const RETRY_WINDOW_MS = 48 * 3_600_000
const RETRY_SPACING_MS = Number(process.env.CAIRN_SUMMARY_RETRY_SPACING_MS ?? 15 * 60_000)

const readUnsummarised = () => {
  try {
    const parsed = JSON.parse(readFileSync(UNSUMMARISED_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const writeUnsummarised = (queue) => {
  try {
    mkdirSync(dirname(UNSUMMARISED_PATH), { recursive: true })
    writeFileSync(UNSUMMARISED_PATH, JSON.stringify(queue))
  } catch {
    // Losing the queue loses a retry, not a session.
  }
}

const updateUnsummarised = (sessionId, change) => {
  const queue = readUnsummarised()
  const next = change(queue[sessionId] ?? null)
  if (next) queue[sessionId] = next
  else delete queue[sessionId]
  writeUnsummarised(queue)
}

/** Due for another attempt, oldest failure first. Pure, for the tests. */
const dueRetries = (queue, now, exclude) =>
  Object.entries(queue)
    .filter(([id, e]) =>
      id !== exclude &&
      e?.path &&
      now - (e.firstAt ?? 0) <= RETRY_WINDOW_MS &&
      (e.tries ?? 0) < RETRY_MAX_TRIES &&
      now - (e.lastAt ?? 0) >= RETRY_SPACING_MS,
    )
    .sort(([, a], [, b]) => (a.firstAt ?? 0) - (b.firstAt ?? 0))
    .slice(0, RETRY_BATCH)

const DEBUG = process.env.CAIRN_HOOK_DEBUG === '1'

const post = (args) =>
  new Promise((resolve) => {
    const child = spawn(CLI, args, {
      stdio: ['ignore', DEBUG ? 'inherit' : 'ignore', DEBUG ? 'inherit' : 'ignore'],
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })

/**
 * The first thing a person actually asked, for when the summariser gave no
 * request. Not the first turn blindly: "hello" is a person, and recording it
 * as what a session was for is how a row reads "hello" months later.
 */
const requestFrom = (t) => {
  const asked = t.prompts.find((p) => !TRIVIAL.test(p))
  return asked ? asked.replace(/\s+/g, ' ').trim().slice(0, 500) : null
}

/**
 * Records one transcript. `opts` carries what a retry has to remember for
 * itself — the platform and agent the first attempt ran under — and marks the
 * retry, which posts only if the summary now exists and never re-checkpoints
 * held tasks from a stale summary.
 *
 * Returns `{ sessionId, failed }`, `failed` meaning the summariser was asked and
 * did not answer, so the caller knows not to spend more calls on retries.
 */
const record = async (payload, opts = {}) => {
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
          refs: [...chooseRefs(t, payload.cwd ?? t.cwd, sessionId)].slice(0, 12),
          refsFrom: refSource(t, payload.cwd ?? t.cwd, sessionId),
          summariser: t.summariser,
          firstPrompt: t.prompts[0]?.slice(0, 120) ?? null,
          request: requestFrom(t)?.slice(0, 120) ?? null,
        },
        null,
        2,
      ),
    )
    return
  }

  // A summariser's own run. Recording it gave 47 of 103 Mac sessions a
  // borrowed summary and the parent's task refs, with no work behind them. A
  // person who later resumed it is a real session, and is kept: their turns
  // are prompts, and the summariser's prompt is not.
  if (t.summariser && t.prompts.length === 0) return { sessionId, skipped: 'summariser' }

  // Nothing happened. A row saying so is noise in every later search.
  //
  // Tool calls alone are not evidence of work: OpenClaw wakes on a schedule,
  // finds nothing to do and answers HEARTBEAT_OK, which is several tool calls
  // and no session anybody will ever want to read. Something a person asked
  // for, a file touched, or a task worked — one of those has to be true.
  if (t.prompts.length === 0 && t.files.size === 0 && t.refs.size === 0) return

  const cwd = payload.cwd ?? t.cwd
  const platform = opts.platform ?? process.env.CAIRN_PLATFORM ?? 'claude'
  const agent = opts.agent ?? process.env.CAIRN_AGENT
  const files = keepFiles(t.files, cwd)
  const outcome = await summaryFor(sessionId, buildDigest(t))
  const summary = outcome.summary ?? {}

  if (outcome.error) {
    logSummariser(`${platform} ${sessionId}${opts.retry ? ' retry' : ''}: ${outcome.error}`)
    updateUnsummarised(sessionId, (e) => ({
      path: transcriptPath,
      cwd: cwd ?? null,
      platform,
      agent: agent ?? null,
      firstAt: e?.firstAt ?? Date.now(),
      lastAt: Date.now(),
      // Only retries count against the limit: Codex fails once per turn
      // during an outage, and that is one failure, not forty.
      tries: (e?.tries ?? 0) + (opts.retry ? 1 : 0),
    }))
    // The row already exists from the first attempt; a retry adds nothing
    // without the prose it came for.
    if (opts.retry) return { sessionId, failed: true }
  } else if (outcome.summary && readUnsummarised()[sessionId]) {
    updateUnsummarised(sessionId, () => null)
    if (opts.retry) logSummariser(`${platform} ${sessionId} retry: summarised`)
  }
  if (opts.retry && !outcome.summary) return { sessionId }

  const args = [
    'session',
    'end',
    '--id',
    sessionId,
    '--platform',
    platform,
    '--cwd',
    cwd ?? process.cwd(),
    '--tool-calls',
    String(t.toolCalls),
  ]

  if (t.startedAt) args.push('--started', t.startedAt)
  if (files.length) args.push('--files', files.join(','))
  const refs = chooseRefs(t, cwd ?? process.cwd(), sessionId)
  if (refs.size) args.push('--tasks', [...refs].slice(0, 400).join(','))
  if (agent) args.push('--agent', agent)
  // The first attempt checkpointed what was held; a late summary must not
  // overwrite a checkpoint written since.
  if (opts.retry) args.push('--no-checkpoint')

  const request = summary.request || requestFrom(t)
  if (request) args.push('--request', request)
  // Said by the only party that can still see it. The prompt is deliberately
  // not stored as the request — it made every headline unreadable — so without
  // this the row arrives with nothing to classify it by.
  if (t.scheduled) args.push('--scheduled')
  for (const [key, flag] of [
    ['learned', '--learned'],
    ['completed', '--completed'],
    ['next_steps', '--next'],
  ]) {
    if (summary[key]) args.push(flag, String(summary[key]).slice(0, 8000))
  }

  await post(args)
  return { sessionId, failed: Boolean(outcome.error) }
}

const retryUnsummarised = async (currentId) => {
  const now = Date.now()
  const queue = readUnsummarised()
  let pruned = false
  for (const [id, e] of Object.entries(queue)) {
    const expired = now - (e?.firstAt ?? 0) > RETRY_WINDOW_MS
    const exhausted = (e?.tries ?? 0) >= RETRY_MAX_TRIES
    if (e?.path && existsSync(e.path) && !expired && !exhausted) continue
    if (exhausted || expired) {
      logSummariser(`${e?.platform ?? '?'} ${id}: gave up after ${e?.tries ?? 0} attempt(s)`)
    }
    delete queue[id]
    pruned = true
  }
  if (pruned) writeUnsummarised(queue)

  for (const [id, e] of dueRetries(queue, now, currentId)) {
    const result = await record(
      { transcript_path: e.path, session_id: id, cwd: e.cwd ?? undefined },
      { platform: e.platform, agent: e.agent ?? undefined, retry: true },
    ).catch(() => null)
    // Still down: stop paying for timeouts, the next run will try again.
    if (result?.failed) break
  }
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
  let failed = false
  for (const rollout of found) {
    const result = await record({ transcript_path: rollout.path, session_id: rollout.id }).catch(() => null)
    if (result?.failed) failed = true
    seen.add(rollout.id)
  }
  rememberSeen(seen)
  console.log(`recorded ${found.length} session(s) from ${root}`)
  if (!failed) await retryUnsummarised(null)
}

const main = async () => {
  const scanRoot = arg('--scan')
  if (scanRoot) return scan(scanRoot, Number(arg('--window-hours') ?? 24))

  const dryIndex = process.argv.indexOf('--dry-run')
  if (DRY_RUN) return record({ transcript_path: process.argv[dryIndex + 1] })

  const result = await record(await readStdin())
  if (!result?.failed) await retryUnsummarised(result?.sessionId ?? null)
}

main().catch((error) => {
  // Silent by default, on purpose: a memory system must never be the reason a
  // session fails to close. CAIRN_HOOK_DEBUG=1 when that silence is the problem.
  if (DEBUG) console.error('[cairn-session-end]', error)
})
