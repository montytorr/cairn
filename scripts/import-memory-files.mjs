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
 *   node scripts/import-memory-files.mjs --map projects.json
 *   node scripts/import-memory-files.mjs --global          # all of it, unscoped
 *
 *   --root <dir>   where the per-project memory directories live
 *   --map <file>   JSON of { "<directory name>": "PROJECT_KEY" | null }, where
 *                  null means import that directory's memory globally
 *   --global       treat every unmapped directory as global rather than
 *                  refusing it
 *
 * Two passes (CAIRN-347). The first reads every file and decides the slug each
 * will be written under, collision re-slugs included; the second rewrites each
 * body's `[[file_stem]]` links to those slugs and writes it. The first pass
 * reads the store to decide collisions, so `--dry-run` reads too — it writes
 * nothing, and the slugs it prints are the ones a real run would use.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linkTargets, planSlugs, rewriteLinks, slugOf } from './memory-links.mjs'

const DRY = process.argv.includes('--dry-run')
const GLOBAL = process.argv.includes('--global')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}
const ROOT = arg('--root') ?? join(homedir(), '.claude', 'projects')

/**
 * Directory name -> Cairn project key, from `--map`.
 *
 * A directory mapped to null is imported globally: memory written in a home
 * directory is usually about the machine and the toolchain rather than one
 * codebase, which is exactly the supra-project case knowledge exists for.
 *
 * There is no built-in mapping, and there cannot be one: these directory names
 * are one machine's own layout. Without a map every directory is unmapped, and
 * an unmapped directory is refused rather than quietly filed global -- knowledge
 * in the wrong scope is read by every project that should not see it.
 */
const PROJECTS = (() => {
  const path = arg('--map')
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`--map ${path}: ${error.message}`)
    process.exit(1)
  }
})()

/**
 * Every directory that holds memory, whether it was mapped or not.
 *
 * Iterating the map alone is why this said nothing useful on a machine it was
 * not written for: each entry was absent, every one was skipped, and the run
 * reported zero imports with no hint that it had found no directories at all.
 */
if (!existsSync(ROOT)) {
  console.error(`no such directory: ${ROOT}\nPass --root <dir> if memory lives elsewhere.`)
  process.exit(1)
}

const unmapped = []
const candidates = readdirSync(ROOT)
  .filter((name) => {
    const dir = join(ROOT, name)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'memory'))
  })
  .map((name) => {
    const mapped = Object.prototype.hasOwnProperty.call(PROJECTS, name)
    if (!mapped && !GLOBAL) unmapped.push(name)
    return [name, mapped ? PROJECTS[name] : null]
  })
  .filter(([name]) => GLOBAL || Object.prototype.hasOwnProperty.call(PROJECTS, name))

if (candidates.length === 0) {
  console.error(
    unmapped.length > 0
      ? `${unmapped.length} director${unmapped.length === 1 ? 'y holds' : 'ies hold'} memory and none is mapped:\n` +
          unmapped.map((n) => `  ${n}`).join('\n') +
          `\n\nWrite a --map file of { "<directory>": "KEY" | null }, or --global to import it all unscoped.`
      : `no memory directories under ${ROOT}`,
  )
  process.exit(1)
}

if (unmapped.length > 0) {
  console.log(`skipping ${unmapped.length} unmapped director${unmapped.length === 1 ? 'y' : 'ies'}:`)
  for (const name of unmapped) console.log(`  ${name}`)
  console.log('')
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

/**
 * The body stored under `slug`, or null when there is none.
 *
 * Asked as two reads so that a miss stays a miss. `cairn know <word>` falls
 * back to a full-text search when the slug is not there, which would record a
 * search per file and return results that look like an answer; `--history`
 * 404s instead, and records nothing. Only a hit is then read for its body,
 * tagged as a sweep so an import does not count as anybody recalling it.
 */
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CAIRN_SWEEP: '1' } }
const storedBody = (slug) => {
  try {
    execFileSync('cairn', ['know', slug, '--history', '--json'], QUIET)
  } catch {
    return null
  }
  try {
    const hit = JSON.parse(execFileSync('cairn', ['know', slug, '--json'], QUIET))
    return typeof hit?.body === 'string' ? hit.body : ''
  } catch {
    // It exists and its body could not be read: a fact we cannot prove is
    // this one is treated as another one, which re-slugs rather than drops.
    return ''
  }
}

let imported = 0
let skipped = 0
const collisions = []
const requalified = []

// Pass one: read every file and decide the slug it will be written under.
// Nothing is written until every slug is known, because a link can point at a
// file that is planned after the one carrying it.
const entries = []
const fileCounts = []

for (const [dir, project] of candidates) {
  const memoryDir = join(ROOT, dir, 'memory')

  const titles = titlesFrom(memoryDir)
  const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  fileCounts.push([dir, project, files.length])

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
    const stem = file.replace(/\.md$/, '')
    const slug = slugOf(front.name || stem)
    // MEMORY.md is supposed to carry a human title per file, but in several
    // projects its link text is just the filename -- which produced 110 rows
    // titled `project_recap_encoding_recurrence`. A title that is only the
    // slug in disguise tells a reader nothing the slug did not.
    const indexed = titles[file]
    const looksLikeFilename = !indexed || /_/.test(indexed) || /^[a-z0-9-]+$/.test(indexed)
    const title =
      (looksLikeFilename ? front.description?.slice(0, 200) : indexed) ||
      indexed ||
      slug.replace(/-/g, ' ')

    const labels = [front.type, project ? null : 'global'].filter(Boolean)

    // The description is the one-line summary and the body is the fact; keeping
    // both means the index line reads well without opening the row.
    const full = front.description ? `${front.description}\n\n${body}` : body

    entries.push({ dir, project, stem, slug, title, labels, full })
  }
}

// A taken slug means one of two very different things, and guessing wrong is
// expensive in both directions. If the row already there has this same body it
// is this same file, imported by an earlier pass -- re-slugging it produced 125
// duplicate rows. If the body differs it is a different project's fact of the
// same name (every codebase has a `feedback-verify-branch-before-commit`), and
// dropping it loses content. That decision used to wait for the write to fail;
// it is made here instead, in the same order, so the link map below knows it.
const plan = planSlugs(entries, storedBody)
const targets = linkTargets(plan)

// Pass two: rewrite each body's `[[file_stem]]` links to the slugs just
// decided, and write it. A link to a stem with no file here is left as it is,
// for `cairn learn` to resolve, warn about or refuse.
for (const entry of plan) {
  if (entry.action === 'present') {
    skipped += 1
    continue
  }
  if (entry.action === 'collision') {
    collisions.push(entry.slug)
    skipped += 1
    continue
  }

  const args = ['learn', entry.title, '--slug', entry.final, '--body', '-']
  if (entry.project) args.push('--project', entry.project)
  if (entry.labels.length) args.push('--label', entry.labels.join(','))

  try {
    cairn(args, rewriteLinks(entry.full, targets.get(entry.dir)))
    imported += 1
    if (entry.requalified) requalified.push(entry.final)
  } catch (error) {
    // `already exists` here means something wrote the slug after it was
    // planned: a collision, reported as one rather than retried under a slug
    // the links were not told about.
    const message = String(error.stderr ?? error.message)
    if (message.includes('already exists')) collisions.push(entry.final)
    else console.error(`  ! ${entry.final}: ${message.trim().split('\n')[0]}`)
    skipped += 1
  }
}

for (const [dir, project, count] of fileCounts) {
  console.log(`${dir} -> ${project ?? 'global'}: ${count} files`)
}

console.log(`\nimported ${imported}, skipped ${skipped}`)
if (requalified.length) console.log(`re-slugged to avoid a collision: ${requalified.length}`)
if (collisions.length) {
  console.log(`slug collisions (already present): ${collisions.length}`)
  console.log(collisions.slice(0, 10).join('\n'))
}
