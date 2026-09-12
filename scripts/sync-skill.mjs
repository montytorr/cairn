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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', 'skills', 'cairn', 'SKILL.md')

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
 * Run as root and `~` IS /root, so the home targets and the explicit ones are
 * the same file — reported twice, the second time as already fine, which reads
 * like a copy that was never touched.
 */
const UNIQUE = TARGETS.filter(
  (target, index) => TARGETS.findIndex((other) => other.path === target.path) === index,
)

const CHECK = process.argv.includes('--check')
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

const canonical = digest(SOURCE)
console.log(`canonical ${canonical}  ${SOURCE}`)

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
    copyFileSync(SOURCE, target.path)
    console.log(`updated   ${state} -> ${canonical}  ${target.path}`)
  } catch (error) {
    console.log(`FAILED    ${state}  ${target.path}  (${error.code ?? error.message})`)
  }
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}
