#!/usr/bin/env node
/**
 * The inject-without-being-queried half of Cairn's memory.
 *
 * Reads a hook payload on stdin and prints the runtime's context response.
 * Claude Code and Codex share a wire format. Hermes Agent by Nous Research
 * injects context from `pre_llm_call`, whose response protocol is different.
 *
 * Three rules govern everything here:
 *
 *   1. Never block. A memory system that can stop a session from starting is
 *      worse than no memory system. Every failure path prints nothing and
 *      exits 0.
 *   2. Never speak when there is nothing to say. An empty heading every
 *      session trains the reader to skip the block, which is how a 12 KB
 *      digest ends up being consulted a hundred times in seventeen days.
 *   3. Stay small. This is a briefing, not a corpus.
 */
import { spawn } from 'node:child_process'

const TIMEOUT_MS = Number(process.env.CAIRN_HOOK_TIMEOUT_MS ?? 4000)
const CLI = process.env.CAIRN_CLI ?? 'cairn'

/**
 * Trig, if this machine has it, gets a line after Cairn's.
 *
 * Trig is the map of what exists. It installs no session hook of its own where
 * this one runs, because two briefings competing for the top of every session
 * is how both get skimmed. But an agent that never hears it exists will never
 * ask it anything, so Cairn — which owns the opening — names it once and gets
 * out of the way.
 *
 * It runs beside Cairn's own call on a short deadline of its own, and is
 * silent when absent, unconfigured, slow or empty. Rule 2 above: never speak
 * when there is nothing to say. A summariser child hears nothing from it: it
 * is a session only by accident, and would pay for the spawn every time.
 */
const TRIG_CLI = process.env.TRIG_CLI ?? 'trig'
const TRIG_TIMEOUT_MS = Number(process.env.CAIRN_TRIG_TIMEOUT_MS ?? 1500)

const SUMMARISER_FLAGS = ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/** The CLI's "several instances, and nothing says which" (cli/cairn.mjs). */
const UNDECIDED_EXIT = 10

/**
 * Runs a CLI with a hard deadline, and treats every failure as "say nothing" —
 * except the CLI saying it cannot tell which instance this directory is for.
 * That is not a failure to hide: its stderr is the instruction the agent needs
 * (ask the user, save the answer), and a silent briefing would leave the agent
 * to find out at its first write.
 */
const runTool = (bin, args, timeoutMs, { undecided = false } = {}) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let err = ''
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      // Killing the child does not kill what it forked: a wrapper script's
      // own child keeps these pipes open, and the hook cannot exit until it
      // ends, so a slow sibling would hold the session for its full run.
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      done('')
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      done('')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? out : undecided && code === UNDECIDED_EXIT ? err : '')
    })
  })

const run = (args) => runTool(CLI, args, TIMEOUT_MS, { undecided: true })

/** One line about the map, or nothing at all. Never throws, never blocks. */
const trigLine = async () => {
  const out = await runTool(TRIG_CLI, ['scans', '--limit', '1', '--json'], TRIG_TIMEOUT_MS)
  if (!out.trim()) return ''
  try {
    const rows = JSON.parse(out)
    const last = Array.isArray(rows) ? rows[0] : (rows?.data ?? rows?.results ?? [])[0]
    if (!last) return ''
    const when = last.finishedAt ?? last.finished_at ?? last.startedAt ?? last.started_at
    const age = when ? Math.round((Date.now() - new Date(when).getTime()) / 3_600_000) : null
    const scanned = age === null ? 'scanned at an unknown time' : age < 1 ? 'scanned within the hour' : `scanned ${age}h ago`
    return `\nTrig — the map of what exists (${scanned}):\n  trig what-is <thing> · trig impact <thing> · trig inbox\n`
  } catch {
    return ''
  }
}

/** Each returns its block with a leading and trailing newline, or ''. */
const SIBLINGS = [trigLine]

const main = async () => {
  const payload = await readStdin()
  const event = payload.hook_event_name ?? 'SessionStart'
  const cwd = payload.cwd ?? process.cwd()

  // Hermes Agent by Nous Research invokes pre_llm_call for every turn. Its
  // first turn is the session-start equivalent; later injection would waste
  // context and break prompt-cache stability.
  //
  // `extra.is_first_turn` is where v0.21.3 actually puts it. Confirmed against
  // a live install, not the docs: jgiffard read the payload out of that build's
  // `agent.shell_hooks._serialize_payload` and posted it on GitHub #64, which
  // is the only way this could be settled — every test here writes a fake
  // `hermes` binary, so it can prove the installer matches OUR MODEL of Hermes
  // and never that the model matches Hermes (CAIRN-243).
  //
  // The top-level read stays as a fallback. It is not the layout this build
  // emits, and it costs one `??`. If it is in neither, we cannot tell "not the
  // first turn" from "this build does not send it", and staying silent would
  // mean never briefing at all with nothing to find. Say so on stderr, which
  // Hermes logs and the user message never sees.
  if (event === 'pre_llm_call') {
    const isFirstTurn = payload.extra?.is_first_turn ?? payload.is_first_turn
    if (isFirstTurn === undefined) {
      process.stderr.write('cairn: pre_llm_call payload carries no is_first_turn, in extra or at top level — no briefing will ever be injected\n')
      return
    }
    if (isFirstTurn !== true) return
  }

  const args = ['context', '--cwd', cwd]

  // PreToolUse on a read: the question is about this file, not the project.
  if (event === 'PreToolUse') {
    const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path
    if (!path) return
    args.push('--file', path)
  }

  // Siblings belong to the opening, not to a question about one file.
  const siblings = event === 'PreToolUse' || SUMMARISER_FLAGS.some((name) => process.env[name] === '1') ? [] : SIBLINGS
  const [cairnText, ...blocks] = await Promise.all([run(args), ...siblings.map((sibling) => sibling(cwd))])
  const text = `${cairnText.trim()}${blocks.join('')}`.trim()
  if (!text) return

  if (event === 'pre_llm_call') {
    process.stdout.write(`${JSON.stringify({ context: text })}\n`)
    return
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
      suppressOutput: true,
    })}\n`,
  )
}

main().catch(() => {})
