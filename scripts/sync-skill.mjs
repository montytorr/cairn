#!/usr/bin/env node
/**
 * One skill, copied everywhere it has to live.
 *
 * Every runtime reads the skill from its own directory, so the same file
 * exists four times on the server and twice on a laptop. They drift silently:
 * a copy edited in place is invisible until an agent behaves differently from
 * its siblings for reasons nobody can see, and the only way to answer "is the
 * skill up to date everywhere" was to walk the filesystem by hand.
 *
 *   node scripts/sync-skill.mjs --check   # report drift, write nothing
 *   node scripts/sync-skill.mjs           # make every reachable copy match
 *
 * Targets that do not apply to this machine are skipped, not invented: the
 * script never creates a runtime's directory, because a skill in a directory
 * no runtime reads is worse than no skill at all. Run it as root on the server
 * to reach the root-owned copies.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

/**
 * Where the canonical skill comes from.
 *
 * A checkout by default. `--source <url>` is for the machine that has no
 * checkout: the repository is public, so raw.githubusercontent is a canonical
 * source that cannot drift, and it is the same main branch the deploy already
 * builds from.
 */
const SOURCE = arg('--source') ?? join(HERE, '..', 'skills', 'cairn', 'SKILL.md')

const readSource = async () => {
  if (!/^https?:\/\//.test(SOURCE)) return readFileSync(SOURCE)
  const response = await fetch(SOURCE)
  if (!response.ok) throw new Error(`${SOURCE} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Where each runtime looks. The parent must already exist to be a target. */
const TARGETS = [
  { path: join(homedir(), '.claude/skills/cairn/SKILL.md'), needs: join(homedir(), '.claude') },
  { path: join(homedir(), '.codex/skills/cairn/SKILL.md'), needs: join(homedir(), '.codex') },
  { path: '/root/.claude/skills/cairn/SKILL.md', needs: '/root/.claude' },
  { path: '/root/.codex/skills/cairn/SKILL.md', needs: '/root/.codex' },
  // OpenClaw reads its skills from the clawd tree, not from a dotfile dir.
  { path: '/root/clawd/skills/cairn/SKILL.md', needs: '/root/clawd/skills' },
]

/**
 * Copies outside this user's home, for a scheduled run that has to reach them.
 *
 * `--also /home/someone/.claude/skills/cairn/SKILL.md`, repeatable. A machine's
 * own layout belongs in the job that runs this, not in a public repository.
 */
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--also') continue
  const path = process.argv[i + 1]
  if (path) TARGETS.push({ path, needs: dirname(dirname(dirname(path))) })
}

/**
 * Run as root and `~` IS /root, so the home targets and the explicit ones are
 * the same file — reported twice, the second time as already fine, which reads
 * like a copy that was never touched.
 */
const UNIQUE = TARGETS.filter(
  (target, index) => TARGETS.findIndex((other) => other.path === target.path) === index,
)

const CHECK = process.argv.includes('--check')
const NOTIFY = arg('--notify')
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)
const digest = (path) => hash(readFileSync(path))

const source = await readSource()
const canonical = hash(source)
console.log(`canonical ${canonical}  ${SOURCE}`)

const repaired = []
let drifted = 0
for (const target of UNIQUE) {
  if (!existsSync(target.needs)) {
    console.log(`skipped   ${'-'.repeat(16)}  ${target.path}  (no ${target.needs} here)`)
    continue
  }

  const present = existsSync(target.path)
  const current = present ? digest(target.path) : null

  if (current === canonical) {
    console.log(`ok        ${current}  ${target.path}`)
    continue
  }

  drifted += 1
  const state = present ? current : 'missing'
  if (CHECK) {
    console.log(`DRIFT     ${state}  ${target.path}`)
    continue
  }

  try {
    mkdirSync(dirname(target.path), { recursive: true })
    writeFileSync(target.path, source)
    repaired.push(`${target.path} (was ${state})`)
    console.log(`updated   ${state} -> ${canonical}  ${target.path}`)
  } catch (error) {
    console.log(`FAILED    ${state}  ${target.path}  (${error.code ?? error.message})`)
  }
}

/**
 * Silence when nothing moved, a record when something did.
 *
 * A scheduled repair that never says anything is indistinguishable from one
 * that is not running, and one that reports every hour trains everybody to
 * ignore it.
 */
if (NOTIFY && repaired.length > 0) {
  const note =
    `Skill sync repaired ${repaired.length} cop${repaired.length === 1 ? 'y' : 'ies'} ` +
    `on ${process.env.HOSTNAME ?? 'this host'}, to ${canonical}:\n` +
    repaired.map((line) => `  ${line}`).join('\n') +
    `\n\nA copy that had drifted was being read by a runtime until now.`
  try {
    execFileSync('cairn', ['note', NOTIFY, note, '--kind', 'note'], { stdio: 'ignore' })
    console.log(`reported to ${NOTIFY}`)
  } catch {
    console.log(`could not report to ${NOTIFY}`)
  }
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}
