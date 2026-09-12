#!/usr/bin/env node
/**
 * One copy of each agent-facing file, everywhere it has to live.
 *
 * The skill, the CLI and the two hooks are read from a directory per runtime,
 * so the same file exists four, five, six times across a laptop and a server.
 * They drift silently, and the drift is invisible until an agent behaves
 * differently from its siblings for reasons nobody can see. Both halves of
 * that bit in one day: a skill copy a day out of date, and a CLI three days
 * old that was still writing under the wrong identity — the very bug the day
 * had been spent fixing.
 *
 *   node scripts/sync-agent-files.mjs --check   # report drift, write nothing
 *   node scripts/sync-agent-files.mjs           # make every reachable copy match
 *
 * Targets that do not apply to this machine are skipped, not invented: a file
 * in a directory no runtime reads is worse than no file at all. Run it as root
 * on the server to reach the root-owned copies.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

/**
 * Where the canonical files come from: a checkout, or the public repository.
 *
 * `--source <url>` is for the machine that has no checkout. raw.githubusercontent
 * cannot drift and is the same main branch the deploy already builds from.
 */
const SOURCE = arg('--source') ?? join(HERE, '..')

const home = homedir()

/** A target applies only if the directory its runtime reads already exists. */
const at = (path, needs) => ({ path, needs: needs ?? dirname(path) })

const ARTEFACTS = [
  {
    name: 'skill',
    file: 'skills/cairn/SKILL.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/cairn/SKILL.md'), join(home, '.claude')),
      at(join(home, '.codex/skills/cairn/SKILL.md'), join(home, '.codex')),
      at('/root/.claude/skills/cairn/SKILL.md', '/root/.claude'),
      at('/root/.codex/skills/cairn/SKILL.md', '/root/.codex'),
      // OpenClaw reads its skills from the clawd tree, not a dotfile dir.
      at('/root/clawd/skills/cairn/SKILL.md', '/root/clawd/skills'),
    ],
  },
  {
    name: 'cli',
    file: 'cli/cairn.mjs',
    mode: 0o755,
    // `needs` is the file itself: update a CLI where one is already installed,
    // never put a second one somewhere nobody asked for. /usr/local/bin exists
    // on every machine; that is not consent to install into it.
    targets: [
      at(join(home, '.local/bin/cairn'), join(home, '.local/bin/cairn')),
      at('/usr/local/bin/cairn', '/usr/local/bin/cairn'),
    ],
  },
  {
    name: 'hook:context',
    file: 'hooks/cairn-context.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.cairn/hooks/cairn-context.mjs')),
      at('/root/.cairn/hooks/cairn-context.mjs'),
    ],
  },
  {
    name: 'hook:session-end',
    file: 'hooks/cairn-session-end.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.cairn/hooks/cairn-session-end.mjs')),
      at('/root/.cairn/hooks/cairn-session-end.mjs'),
    ],
  },
]

/**
 * Copies outside this user's home, for a scheduled run that has to reach them.
 * `--also <artefact>=<path>`, repeatable. A machine's own layout belongs in the
 * job that runs this, not in a public repository.
 */
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--also') continue
  const [name, path] = (process.argv[i + 1] ?? '').split('=')
  const artefact = ARTEFACTS.find((a) => a.name === name)
  if (artefact && path) artefact.targets.push(at(path))
}

const CHECK = process.argv.includes('--check')
const NOTIFY = arg('--notify')
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)

const readSource = async (file) => {
  if (!/^https?:\/\//.test(SOURCE)) return readFileSync(join(SOURCE, file))
  const response = await fetch(`${SOURCE.replace(/\/+$/, '')}/${file}`)
  if (!response.ok) throw new Error(`${file} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const repaired = []
let drifted = 0

for (const artefact of ARTEFACTS) {
  const source = await readSource(artefact.file)
  const canonical = hash(source)
  console.log(`\n${artefact.name}  ${canonical}  ${artefact.file}`)

  // Run as root and `~` IS /root, so the home targets and the explicit ones
  // are the same file — reported twice, the second time as already fine,
  // which reads like a copy that was never touched.
  const unique = artefact.targets.filter(
    (t, i) => artefact.targets.findIndex((o) => o.path === t.path) === i,
  )

  for (const target of unique) {
    if (!existsSync(target.needs)) {
      console.log(`  skipped   ${target.path}  (no ${target.needs} here)`)
      continue
    }

    const present = existsSync(target.path)
    const current = present ? hash(readFileSync(target.path)) : null
    if (current === canonical) {
      console.log(`  ok        ${target.path}`)
      continue
    }

    drifted += 1
    const state = present ? current : 'missing'
    if (CHECK) {
      console.log(`  DRIFT     ${target.path}  (${state})`)
      continue
    }

    try {
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, source)
      chmodSync(target.path, artefact.mode)
      repaired.push(`${artefact.name}: ${target.path} (was ${state})`)
      console.log(`  updated   ${target.path}  ${state} -> ${canonical}`)
    } catch (error) {
      console.log(`  FAILED    ${target.path}  (${error.code ?? error.message})`)
    }
  }
}

/**
 * Silence when nothing moved, a record when something did. A scheduled repair
 * that never says anything is indistinguishable from one that is not running,
 * and one that reports every hour trains everybody to ignore it.
 */
if (NOTIFY && repaired.length > 0) {
  const note =
    `Agent files repaired on ${process.env.HOSTNAME ?? 'this host'} ` +
    `(${repaired.length} cop${repaired.length === 1 ? 'y' : 'ies'}):\n` +
    repaired.map((line) => `  ${line}`).join('\n') +
    `\n\nEach was being read by a runtime in that state until now.`
  try {
    execFileSync('cairn', ['note', NOTIFY, note, '--kind', 'note'], { stdio: 'ignore' })
    console.log(`\nreported to ${NOTIFY}`)
  } catch {
    console.log(`\ncould not report to ${NOTIFY}`)
  }
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}
