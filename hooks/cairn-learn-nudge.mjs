#!/usr/bin/env node
/**
 * Asks the agent, once per session, whether the work it just finished taught
 * anything the next agent should know (CAIRN-323).
 *
 * Agents can already `cairn learn`; mostly nobody asks them to. The close of a
 * task asks (`cairn done` says it), but many sessions close nothing:
 * exploration, design, debugging with no fix yet. This is the other moment
 * the work is done — the agent handing control back — so it runs on Stop, in
 * Claude Code and Codex, the two runtimes whose Stop can be blocked. A block
 * keeps the agent going for one more reply, which the person waits for and
 * sees, so it is spent sparingly:
 *
 *   - only after a turn that did something: edited a file or made a commit.
 *     Judged from the transcript, without a model — this costs nothing;
 *   - at most once per session;
 *   - never on the continuation a block itself caused (`stop_hook_active`);
 *   - never in a session that already ran `cairn learn`;
 *   - never inside a summariser or with CAIRN_LEARN_NUDGE=0.
 *
 * Silent on every failure: a memory prompt must never be the reason a turn
 * cannot end.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SUMMARISER_FLAGS = ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']

const STATE_PATH = join(homedir(), '.cairn', 'nudged.json')
const STATE_KEPT = 200

/** Enough to hold the turn that just ended; a long session's head is not needed. */
const TAIL_BYTES = 512 * 1024

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const COMMIT = /\bgit\b[^\n]*\bcommit\b/
/** Run as a command of its own, not quoted by grep or asked for its help. */
const LEARNED = /(?:^|[\n;&|(]\s*)(?:\w+=\S*\s+)*cairn (?:re)?learn\s+(?!-h\b|--help\b)\S/

const REASON =
  'Before you hand back: did this work establish something the next agent should know — ' +
  'a constraint, a trap, a decision and its reason, or a dead end? If so, record it now: ' +
  '`cairn learn "<title>" --project <KEY> --body -` (add `--task <ref>` when it came from ' +
  'one), or `cairn note <ref> "<what failed>" --kind attempt` for a dead end. If nothing ' +
  'qualifies, stop without saying more. Cairn asks this once per session.'

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const readTail = (path) => {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_BYTES)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  // A cut first line is not JSON; drop it rather than guess.
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

/** A person's prompt, in either runtime's transcript — the start of a turn. */
const isPrompt = (row) => {
  if (row.type === 'user' && !row.isMeta) {
    const content = row.message?.content
    if (typeof content === 'string') return content.trim().length > 0
    return Array.isArray(content) && content.some((c) => c?.type === 'text')
  }
  const p = row.payload
  return row.type === 'response_item' && p?.type === 'message' && p.role === 'user'
}

/** Codex's shell call carries `{"command": ["bash", "-lc", "<script>"]}` or `{"cmd": …}`. */
const shellCommand = (args) => {
  try {
    const parsed = JSON.parse(args)
    const command = parsed?.cmd ?? parsed?.command
    return Array.isArray(command) ? String(command.at(-1) ?? '') : typeof command === 'string' ? command : ''
  } catch {
    return args
  }
}

/** What a transcript row did: an edit, a shell command, or nothing we count. */
const actionsOf = (row) => {
  const out = []
  for (const c of Array.isArray(row.message?.content) ? row.message.content : []) {
    if (c?.type !== 'tool_use') continue
    if (EDIT_TOOLS.has(c.name)) out.push({ edit: true })
    const command = c.input?.command
    if (typeof command === 'string') out.push({ command })
  }
  const p = row.payload
  if (row.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call')) {
    if (EDIT_TOOLS.has(p.name)) out.push({ edit: true })
    const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : ''
    if (/\*\*\* (?:Update|Add) File:/.test(args)) out.push({ edit: true })
    const command = shellCommand(args)
    if (command) out.push({ command })
  }
  return out
}

const parseRows = (lines) => {
  const rows = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // a torn line
    }
  }
  return rows
}

/** Whether the turn that just ended did work worth asking about. */
const turnDidWork = (tail) => {
  const rows = parseRows(tail.split('\n'))
  let from = rows.length - 1
  while (from >= 0 && !isPrompt(rows[from])) from--
  const actions = rows.slice(from + 1).flatMap(actionsOf)
  return actions.some((a) => a.edit || (a.command && COMMIT.test(a.command)))
}

/**
 * Whether the agent RAN `cairn learn` in this session. The words alone are
 * everywhere — the briefing, the skill, this hook's own question — so only a
 * command counts, and only the lines that mention it are parsed.
 */
const alreadyLearned = (path) =>
  parseRows(readFileSync(path, 'utf8').split('\n').filter((line) => /cairn (?:re)?learn/.test(line)))
    .flatMap(actionsOf)
    .some((a) => a.command && LEARNED.test(a.command))

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const remember = (state, sessionId) => {
  const next = Object.fromEntries(
    [...Object.entries(state), [sessionId, Date.now()]].sort((a, b) => b[1] - a[1]).slice(0, STATE_KEPT),
  )
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(next))
}

const main = async () => {
  if (process.env.CAIRN_LEARN_NUDGE === '0') return
  if (SUMMARISER_FLAGS.some((name) => process.env[name] === '1')) return

  const payload = await readStdin()
  if (payload.stop_hook_active) return
  const sessionId = payload.session_id
  const path = payload.transcript_path
  if (!sessionId || !path || !existsSync(path)) return

  const state = readState()
  if (state[sessionId]) return

  if (!turnDidWork(readTail(path))) return
  // The whole file, but only once a turn did work, and only until this
  // session is asked: a learn early in the session answers it for the rest.
  if (alreadyLearned(path)) return

  remember(state, sessionId)
  process.stdout.write(JSON.stringify({ decision: 'block', reason: REASON }))
}

main().catch((error) => {
  if (process.env.CAIRN_HOOK_DEBUG === '1') console.error('[cairn-learn-nudge]', error)
})
