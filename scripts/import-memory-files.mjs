#!/usr/bin/env node
/**
 * Imports curated agent memory files into Cairn knowledge.
 *
 * Claude Code writes memory as one markdown file per fact under
 * `~/.claude/projects/<dir>/memory/`, with frontmatter carrying a kebab-case
 * `name` and a one-line `description`, and `[[wiki-links]]` between them. That
 * shape is already what `knowledge` holds -- the slug, the title, the body and
 * the links all map across without reinterpretation.
 *
 * These are the good part of the memory that existed before Cairn held any:
 * hand-written, corrected over months, and about things that are still true.
 * The machine-generated observation corpus is deliberately NOT imported here.
 *
 * Usage:
 *   node scripts/import-memory-files.mjs --dry-run
 *   node scripts/import-memory-files.mjs
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
const ROOT = join(homedir(), '.claude', 'projects')

/**
 * Directory name -> Cairn project key.
 *
 * `-Users-cal` is the home directory: memory written there is about the machine
 * and the toolchain, not about one codebase, so it lands global -- which is
 * exactly the supra-project case knowledge exists for.
 */
const PROJECTS = {
  '-Users-cal-maestro-dev-hermes-manager': 'HM',
  '-Users-cal-maestro-dev-tribe-dispatcher': 'TD',
  '-Users-cal-maestro-dev-asha-trading': 'AT',
  '-Users-cal-maestro-dev-dispofi-client': 'DC',
  '-Users-cal-maestro-dev-dispofi-distributor': 'DD',
  '-Users-cal-maestro-dev-linear': 'CAIRN',
  '-Users-cal-maestro-dev-cairn': 'CAIRN',
  '-Users-cal-maestro-dev-disposur-rdv': 'DISPOS',
  '-Users-cal-maestro-dev-hermes': 'HERMES',
  '-Users-cal-maestro-dev-dispofi-rag': 'DA',
  '-Users-cal-maestro-dev-dispofi-ai': 'DA',
  '-Users-cal-maestro-dev-dispofi-api': 'DISPOF',
  '-Users-cal-maestro-dev-openclaw-dashboard': 'OD',
  '-Users-cal-maestro-dev-amazon-arbitrage': 'AA',
  '-Users-cal-maestro-dev-trading-bot-apex-one': 'TBV',
  '-Users-cal': null,
}

const parse = (raw) => {
  if (!raw.startsWith('---')) return { front: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { front: {}, body: raw }

  const front = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (m) front[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  // `type:` lives under a nested metadata block; the flat scan above catches it.
  return { front, body: raw.slice(end + 4).trim() }
}

/** MEMORY.md carries the human-written title for each file. Nothing else does. */
const titlesFrom = (dir) => {
  const path = join(dir, 'MEMORY.md')
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^-\s*\[([^\]]+)\]\(([^)]+\.md)\)/)
    if (m) out[m[2]] = m[1].replace(/\.md$/, '')
  }
  return out
}

const cairn = (args, body) => {
  if (DRY) return 'dry-run'
  return execFileSync('cairn', args, { input: body ?? '', encoding: 'utf8' })
}

let imported = 0
let skipped = 0
const collisions = []
const requalified = []

for (const [dir, project] of Object.entries(PROJECTS)) {
  const memoryDir = join(ROOT, dir, 'memory')
  if (!existsSync(memoryDir)) continue

  const titles = titlesFrom(memoryDir)
  const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')

  for (const file of files) {
    const raw = readFileSync(join(memoryDir, file), 'utf8')
    const { front, body } = parse(raw)
    if (!body.trim()) {
      skipped += 1
      continue
    }

    // The slug CHECK in 013 allows lowercase words separated by single
    // hyphens. Frontmatter names are mostly already that shape, but 148 of
    // these files use underscores (`project_aircall_widget_...`) and were
    // being rejected outright rather than collided -- which looked identical
    // in the summary and was not.
    const slug = (front.name || file.replace(/\.md$/, ''))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const title = titles[file] || front.description?.slice(0, 200) || slug.replace(/-/g, ' ')

    const labels = [front.type, project ? null : 'global'].filter(Boolean)

    const args = ['learn', title, '--slug', slug, '--body', '-']
    if (project) args.push('--project', project)
    if (labels.length) args.push('--label', labels.join(','))

    // The description is the one-line summary and the body is the fact; keeping
    // both means the index line reads well without opening the row.
    const full = front.description ? `${front.description}\n\n${body}` : body

    try {
      cairn(args, full)
      imported += 1
    } catch (error) {
      const message = String(error.stderr ?? error.message)
      if (!message.includes('already exists')) {
        console.error(`  ! ${slug}: ${message.trim().split('\n')[0]}`)
        skipped += 1
        continue
      }

      // A taken slug means one of two very different things, and guessing
      // wrong is expensive in both directions. If the row already there has
      // this exact body it is this same file, imported by an earlier pass --
      // re-slugging it produced 125 duplicate rows. If the body differs it is
      // a different project's fact of the same name (every codebase has a
      // `feedback-verify-branch-before-commit`), and dropping it loses content.
      let existing = null
      try {
        existing = JSON.parse(
          execFileSync('cairn', ['know', slug, '--json'], { encoding: 'utf8' }),
        )
      } catch {
        existing = null
      }

      if (existing && existing.body?.trim() === full.trim()) {
        skipped += 1
        continue
      }

      if (!project) {
        collisions.push(slug)
        skipped += 1
        continue
      }

      const qualified = `${project.toLowerCase()}-${slug}`
      try {
        cairn([...args.slice(0, 2), '--slug', qualified, ...args.slice(4)], full)
        imported += 1
        requalified.push(qualified)
      } catch {
        collisions.push(slug)
        skipped += 1
      }
    }
  }
  console.log(`${dir} -> ${project ?? 'global'}: ${files.length} files`)
}

console.log(`\nimported ${imported}, skipped ${skipped}`)
if (requalified.length) console.log(`re-slugged to avoid a collision: ${requalified.length}`)
if (collisions.length) {
  console.log(`slug collisions (already present): ${collisions.length}`)
  console.log(collisions.slice(0, 10).join('\n'))
}
