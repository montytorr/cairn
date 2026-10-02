import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude Code memory links files by stem — `[[feedback_verify_branch]]` — and
 * the importer writes each file under its frontmatter name, re-slugging a
 * collision to `<project>-<slug>`. Nothing rewrote the links, so every one of
 * them pointed at an entry nobody wrote, or at another project's fact that
 * owned the name (CAIRN-347).
 */

type Entry = { dir: string; project: string | null; stem: string; slug: string; full: string }
type Planned = Entry & { action: 'learn' | 'present' | 'collision'; final: string | null; requalified: boolean }
type Links = {
  slugOf: (name: string) => string
  rewriteLinks: (body: string, targets: Map<string, string> | undefined) => string
  sameIgnoringLinks: (a: string, b: string) => boolean
  planSlugs: (entries: Entry[], lookup: (slug: string) => string | null) => Planned[]
  linkTargets: (plan: Planned[]) => Map<string, Map<string, string>>
}

// A path, not a literal, so the type checker does not go looking for
// declarations of a plain .mjs script.
const links = (await import(/* @vite-ignore */ join(process.cwd(), 'scripts/memory-links.mjs'))) as Links

describe('rewriting [[stem]] links to the slug the file is written under', () => {
  const targets = new Map([
    ['feedback-verify-branch', 'cai-verify-branch-before-commit'],
    ['project-aircall-widget', 'aircall-widget'],
  ])

  it('rewrites a stem link, whatever its underscores and case', () => {
    expect(links.rewriteLinks('See [[feedback_verify_branch]] and [[Project_Aircall_Widget]].', targets)).toBe(
      'See [[cai-verify-branch-before-commit]] and [[aircall-widget]].',
    )
  })

  it('leaves a link to a stem with no file alone, for the write check to judge', () => {
    expect(links.rewriteLinks('See [[some_other_fact]].', targets)).toBe('See [[some_other_fact]].')
  })

  it('does not touch a link quoted as code, which the renderer never links', () => {
    const body = 'Write `[[feedback_verify_branch]]` like so.\n\n```\n[[project_aircall_widget]]\n```\nThen [[project_aircall_widget]].'

    expect(links.rewriteLinks(body, targets)).toBe(
      'Write `[[feedback_verify_branch]]` like so.\n\n```\n[[project_aircall_widget]]\n```\nThen [[aircall-widget]].',
    )
  })

  it('folds a stem the same way slugs are folded', () => {
    expect(links.slugOf('Project_Aircall__Widget.v2')).toBe('project-aircall-widget-v2')
  })
})

describe('deciding every slug before anything is written', () => {
  const entry = (over: Partial<Entry>): Entry => ({
    dir: 'proj-a',
    project: 'CAI',
    stem: 'x',
    slug: 'x',
    full: 'body',
    ...over,
  })

  it('re-slugs a name another fact holds, and points the links at the re-slug', () => {
    const plan = links.planSlugs(
      [
        entry({ stem: 'feedback_verify_branch', slug: 'feedback-verify-branch', full: 'ours' }),
        entry({ stem: 'notes', slug: 'notes', full: 'See [[feedback_verify_branch]].' }),
      ],
      (slug) => (slug === 'feedback-verify-branch' ? 'another project’s fact' : null),
    )

    expect(plan.map((p) => [p.action, p.final, p.requalified])).toEqual([
      ['learn', 'cai-feedback-verify-branch', true],
      ['learn', 'notes', false],
    ])
    const targets = links.linkTargets(plan).get('proj-a')
    expect(links.rewriteLinks('See [[feedback_verify_branch]].', targets)).toBe(
      'See [[cai-feedback-verify-branch]].',
    )
  })

  it('maps the stem to the frontmatter name the file is written under', () => {
    const plan = links.planSlugs([entry({ stem: 'project_widget_bug', slug: 'widget-bug' })], () => null)

    expect(links.linkTargets(plan).get('proj-a')?.get('project-widget-bug')).toBe('widget-bug')
  })

  it('recognises a file imported before links were rewritten, rather than duplicating it', () => {
    const plan = links.planSlugs(
      [entry({ slug: 'notes', full: 'See [[cai-feedback-verify-branch]].' })],
      () => 'See [[feedback_verify_branch]].',
    )

    expect(plan[0]).toMatchObject({ action: 'present', final: 'notes' })
  })

  it('reports a global file whose name is taken as a collision, and maps no link to it', () => {
    const plan = links.planSlugs([entry({ project: null, stem: 'taken', slug: 'taken' })], () => 'other')

    expect(plan[0]).toMatchObject({ action: 'collision', final: null })
    expect(links.linkTargets(plan).get('proj-a')?.has('taken')).toBeFalsy()
  })

  it('sees a name claimed earlier in the same run, as the write used to', () => {
    const plan = links.planSlugs(
      [
        entry({ dir: 'proj-a', project: 'CAI', slug: 'shared', full: 'one fact' }),
        entry({ dir: 'proj-b', project: 'HM', slug: 'shared', full: 'a different fact' }),
      ],
      () => null,
    )

    expect(plan.map((p) => p.final)).toEqual(['shared', 'hm-shared'])
  })

  it('keeps link maps per directory, the scope the links were written in', () => {
    const plan = links.planSlugs(
      [
        entry({ dir: 'proj-a', project: 'CAI', stem: 'verify', slug: 'verify', full: 'a' }),
        entry({ dir: 'proj-b', project: 'HM', stem: 'verify', slug: 'verify', full: 'b' }),
      ],
      () => null,
    )
    const targets = links.linkTargets(plan)

    expect(targets.get('proj-a')?.get('verify')).toBe('verify')
    expect(targets.get('proj-b')?.get('verify')).toBe('hm-verify')
  })
})

/**
 * The script end to end, against a stand-in `cairn` on PATH that records what
 * it is asked to write and holds one pre-existing entry. The real CLI is never
 * reached: the stand-in is first on PATH, and the environment points anything
 * else at an address nothing listens on, under a throwaway HOME.
 */
describe('scripts/import-memory-files.mjs', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  it('writes bodies whose stem links name the slugs the files were written under', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cairn-import-'))
    directories.push(root)
    const memory = join(root, 'projects', 'proj-a', 'memory')
    await mkdir(memory, { recursive: true })
    const bin = join(root, 'bin')
    await mkdir(bin)
    const log = join(root, 'learned.jsonl')

    await writeFile(
      join(memory, 'feedback_verify_branch.md'),
      '---\nname: feedback-verify-branch\ndescription: Verify the branch\n---\nAlways check.',
    )
    await writeFile(
      join(memory, 'release_steps.md'),
      '---\nname: release-steps\ndescription: How to release\n---\nFirst [[feedback_verify_branch]], then [[nowhere_file]].',
    )

    // Holds `feedback-verify-branch` already, as a different fact: the import
    // has to re-slug it, and the link in release_steps has to follow.
    await writeFile(
      join(bin, 'cairn'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const held = { 'feedback-verify-branch': 'Somebody else’s fact.' }
if (args[0] === 'know') {
  if (!(args[1] in held)) process.exit(1)
  if (args.includes('--history')) { process.stdout.write('{}'); process.exit(0) }
  process.stdout.write(JSON.stringify({ slug: args[1], body: held[args[1]] }))
  process.exit(0)
}
if (args[0] === 'learn') {
  const body = fs.readFileSync(0, 'utf8')
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ slug: args[args.indexOf('--slug') + 1], body }) + '\\n')
  process.stdout.write('{}')
  process.exit(0)
}
process.exit(3)
`,
    )
    await chmod(join(bin, 'cairn'), 0o755)
    await writeFile(join(root, 'map.json'), JSON.stringify({ 'proj-a': 'CAI' }))

    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['scripts/import-memory-files.mjs', '--root', join(root, 'projects'), '--map', join(root, 'map.json')],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: root,
            CAIRN_BASE_URL: 'http://127.0.0.1:9',
            CAIRN_API_KEY: 'test-key',
          },
        },
      )
      child.stdout.resume()
      child.stderr.resume()
      child.on('error', reject)
      child.on('close', resolve)
    })

    expect(code).toBe(0)
    const learned = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { slug: string; body: string })
    expect(learned.map((l) => l.slug).sort()).toEqual(['cai-feedback-verify-branch', 'release-steps'])
    expect(learned.find((l) => l.slug === 'release-steps')?.body).toBe(
      'How to release\n\nFirst [[cai-feedback-verify-branch]], then [[nowhere_file]].',
    )
  })
})
