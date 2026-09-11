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
import { createReadStream } from 'node:fs'
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

const TASK_REF = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

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
      if (isHumanTurn(text)) out.prompts.push(text)
      for (const m of text.matchAll(TASK_REF)) out.refs.add(m[0])
      continue
    }

    if (row.type !== 'assistant' || !Array.isArray(content)) continue

    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        out.assistantText.push(block.text)
        for (const m of block.text.matchAll(TASK_REF)) out.refs.add(m[0])
        continue
      }
      if (block?.type !== 'tool_use') continue

      out.toolCalls += 1
      const input = block.input ?? {}
      for (const key of PATH_KEYS) {
        if (typeof input[key] === 'string') out.files.add(input[key])
      }
      // Edits arrive as a batch on MultiEdit; the path is still file_path.
      if (typeof input.command === 'string') {
        for (const m of input.command.matchAll(TASK_REF)) out.refs.add(m[0])
      }
    }
  }

  return out
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

const main = async () => {
  const payload = await readStdin()
  const transcriptPath = payload.transcript_path
  const sessionId = payload.session_id
  if (!transcriptPath || !sessionId) return

  const t = await parseTranscript(transcriptPath).catch(() => null)
  if (!t) return

  // Nothing happened. A row saying so is noise in every later search.
  if (t.toolCalls === 0 && t.prompts.length === 0) return

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
  if (t.refs.size) args.push('--tasks', [...t.refs].slice(0, 400).join(','))
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

main().catch((error) => {
  // Silent by default, on purpose: a memory system must never be the reason a
  // session fails to close. CAIRN_HOOK_DEBUG=1 when that silence is the problem.
  if (DEBUG) console.error('[cairn-session-end]', error)
})
