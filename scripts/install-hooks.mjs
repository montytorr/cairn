#!/usr/bin/env node
/**
 * Wires Cairn's memory hooks into the agent runtimes on this machine.
 *
 * Three mechanisms, the same three everywhere:
 *   session start  -> inject the briefing
 *   read a file    -> inject what is known about it
 *   session end    -> record what happened, checkpoint what is still held
 *
 * Idempotent: run it again after an upgrade and it replaces its own entries
 * without touching anyone else's. Every entry it owns is tagged, and tagging
 * is how it knows what is safe to replace.
 *
 * Usage: node scripts/install-hooks.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
const HOME = homedir()
const REPO = dirname(import.meta.dirname)

const CONTEXT = join(HOME, '.cairn', 'hooks', 'cairn-context.mjs')
const SESSION_END = join(HOME, '.cairn', 'hooks', 'cairn-session-end.mjs')

/** Marks the entries this installer owns, so re-running replaces rather than duplicates. */
const TAG = 'cairn-memory'

const log = (...a) => console.log(...a)

const writeJson = (path, value) => {
  if (DRY) return log(`  would write ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak-cairn`)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// --- the hook scripts themselves -------------------------------------------

const installScripts = () => {
  if (DRY) return log(`  would copy hooks into ${dirname(CONTEXT)}`)
  mkdirSync(dirname(CONTEXT), { recursive: true })
  copyFileSync(join(REPO, 'hooks', 'cairn-context.mjs'), CONTEXT)
  copyFileSync(join(REPO, 'hooks', 'cairn-session-end.mjs'), SESSION_END)
  log(`  scripts -> ${dirname(CONTEXT)}`)
}

// --- Claude Code ------------------------------------------------------------

/**
 * Claude Code is the only runtime with a real SessionEnd, so it gets the whole
 * design as designed. The others approximate it.
 */
const installClaude = () => {
  const path = join(HOME, '.claude', 'settings.json')
  if (!existsSync(path)) return log('  no ~/.claude/settings.json — skipped')

  const settings = readJson(path)
  settings.hooks ??= {}

  const mine = (command, extra = {}) => ({ type: 'command', command, [TAG]: true, ...extra })

  const replace = (event, matcher, entry) => {
    const groups = (settings.hooks[event] ?? []).filter(
      (g) => !(g.hooks ?? []).some((h) => h[TAG]),
    )
    groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] })
    settings.hooks[event] = groups
  }

  replace('SessionStart', 'startup|resume|clear|compact', mine(`node ${CONTEXT}`, { timeout: 10 }))
  replace('PreToolUse', 'Read', mine(`node ${CONTEXT}`, { timeout: 10, async: true }))
  replace('SessionEnd', null, mine(`node ${SESSION_END}`, { timeout: 120, async: true }))

  writeJson(path, settings)
  log('  claude: SessionStart, PreToolUse(Read), SessionEnd')
}

// --- Codex ------------------------------------------------------------------

/**
 * Codex shares Claude Code's wire format exactly, so the same scripts serve it.
 * Two differences that matter: there is no SessionEnd, so the recorder runs on
 * Stop and leans on the API being idempotent; and every handler has to be
 * trusted in config.toml before it runs, which this cannot do for you.
 */
const installCodex = () => {
  const path = join(HOME, '.codex', 'hooks.json')
  if (!existsSync(join(HOME, '.codex'))) return log('  no ~/.codex — skipped')

  const config = readJson(path)
  config.hooks ??= {}

  const mine = (command, extra = {}) => ({ type: 'command', command, [TAG]: true, ...extra })

  const replace = (event, matcher, entry) => {
    const groups = (config.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((h) => h[TAG]))
    groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] })
    config.hooks[event] = groups
  }

  // CAIRN_AGENT names the runtime, and the CLI picks the matching key out of
  // ~/.cairn/env. Without it every runtime on a machine shares one key, and
  // the key is the identity -- which is how one host had Codex's work all
  // filed under OpenClaw's name.
  const env = 'CAIRN_AGENT=codex CAIRN_PLATFORM=codex'

  replace('SessionStart', 'startup|resume|clear', mine(`${env} node ${CONTEXT}`, { timeout: 10 }))
  replace('PreToolUse', 'Read', mine(`${env} node ${CONTEXT}`, { timeout: 10, async: true }))
  replace('Stop', null, mine(`${env} node ${SESSION_END}`, { timeout: 120, async: true }))

  writeJson(path, config)
  log('  codex: SessionStart, PreToolUse(Read), Stop')
  log('  codex: entries must be trusted on next launch — [hooks.state] in config.toml')
  log('  codex: needs CAIRN_API_KEY_CODEX in ~/.cairn/env, or it writes as whoever')
  log('         owns the plain CAIRN_API_KEY there')
}

// --- OpenClaw ---------------------------------------------------------------

/**
 * OpenClaw has no injectable session-start event; what it has is
 * `agent:bootstrap` with a mutable bootstrapFiles list, which its existing
 * task-enforcer hook already uses. So the instruction here is to extend that
 * hook rather than add another, and it runs on a different machine.
 */
const openclawNotes = () => {
  log('  openclaw: manual — extend /root/clawd/hooks/task-enforcer/handler.ts')
  log('            push `cairn context --project <KEY>` output as a bootstrap file')
  log('            and schedule `cairn reconcile` via `openclaw automations`')
  log('            export CAIRN_AGENT=openclaw where it is launched, so a box')
  log('            it shares with Codex still attributes writes correctly')
}

const version = () => {
  try {
    return execFileSync('cairn', ['--help'], { encoding: 'utf8' }).split('\n')[0]
  } catch {
    return 'cairn CLI not on PATH — install it first'
  }
}

log(`Installing Cairn memory hooks${DRY ? ' (dry run)' : ''}`)
log(`  ${version()}`)
installScripts()
installClaude()
installCodex()
openclawNotes()
