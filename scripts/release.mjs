#!/usr/bin/env node
/**
 * Cut a release: bump both version strings, close the changelog section, tag.
 *
 * This exists because the process lived in whoever remembered it, and it has
 * two version strings to keep in step by hand — package.json, which the server
 * reports, and the constant in cli/cairn.mjs, which a copied CLI reports.
 * Forgetting the second one is the dangerous half: every stale install then
 * agrees with a server that has moved on, and `cairn --version`, the one
 * mechanism for noticing drift, says all is well.
 *
 * Usage: node scripts/release.mjs <version> [--confirm]
 *        node scripts/release.mjs 0.6.0            # shows what it would do
 *        node scripts/release.mjs 0.6.0 --confirm  # writes, commits, tags
 *
 * It does not push. Pushing a tag is a release, and that stays a decision.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const [version, ...rest] = process.argv.slice(2)
const CONFIRM = rest.includes('--confirm')

const die = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!version || version === '--help') die('usage: node scripts/release.mjs <version> [--confirm]')
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`not a semver version: ${version}`)

// en-CA is YYYY-MM-DD; Paris, so a release cut just after midnight there is not dated the day before.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

// --- the two version strings -----------------------------------------------

const pkgRaw = readFileSync('package.json', 'utf8')
const current = JSON.parse(pkgRaw).version
if (current === version) die(`package.json is already ${version}`)

const cliRaw = readFileSync('cli/cairn.mjs', 'utf8')
if (!new RegExp(`^const VERSION = '${current}'`, 'm').test(cliRaw)) {
  die(`cli/cairn.mjs does not say ${current} — the two are already out of step, fix that first`)
}

const nextPkg = pkgRaw.replace(`"version": "${current}"`, `"version": "${version}"`)
const nextCli = cliRaw.replace(
  new RegExp(`^const VERSION = '${current}'`, 'm'),
  `const VERSION = '${version}'`,
)

// --- the changelog ----------------------------------------------------------

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/.exec(changelog)
if (!unreleased) die('no [Unreleased] section found in CHANGELOG.md')
const body = unreleased[1].trim()
if (!body) die('[Unreleased] is empty — nothing to release')

const unreleasedLink = new RegExp(`^\\[Unreleased\\]: (\\S+)/compare/v${current.replaceAll('.', '\\.')}\\.\\.\\.HEAD$`, 'm')
const compareBase = unreleasedLink.exec(changelog)?.[1]
if (!compareBase) die(`no "[Unreleased]: .../compare/v${current}...HEAD" link found in CHANGELOG.md`)

const nextChangelog = changelog
  .replace(
    /## \[Unreleased\]\n[\s\S]*?(?=\n## \[)/,
    `## [Unreleased]\n\n## [${version}] — ${today}\n\n${body}\n`,
  )
  .replace(
    unreleasedLink,
    `[Unreleased]: ${compareBase}/compare/v${version}...HEAD\n` +
      `[${version}]: ${compareBase}/compare/v${current}...v${version}`,
  )

const tagMessage = `v${version}\n\n${body}\n\n**Full Changelog**: ${compareBase}/compare/v${current}...v${version}\n`

// --- report, then act -------------------------------------------------------

const entries = body.split('\n').filter((line) => line.startsWith('- ')).length
const commits = execFileSync('git', ['rev-list', `v${current}..HEAD`, '--count'], {
  encoding: 'utf8',
}).trim()

process.stdout.write(
  `${current} -> ${version}\n` +
    `  package.json, cli/cairn.mjs VERSION\n` +
    `  CHANGELOG [Unreleased] -> [${version}] — ${today} (${entries} entries)\n` +
    `  ${commits} commits since v${current}\n`,
)

if (!CONFIRM) {
  process.stdout.write('\nnothing written. pass --confirm to write, commit and tag.\n')
  process.exit(0)
}

writeFileSync('package.json', nextPkg)
writeFileSync('cli/cairn.mjs', nextCli)
writeFileSync('CHANGELOG.md', nextChangelog)

execFileSync('git', ['add', 'package.json', 'cli/cairn.mjs', 'CHANGELOG.md'])
execFileSync('git', ['commit', '-m', `release ${version}`])
execFileSync('git', ['tag', '-a', `v${version}`, '--cleanup=verbatim', '-F', '-'], { input: tagMessage })

process.stdout.write(
  `\ncommitted and tagged v${version}. Not pushed — review, then:\n` +
    `  git push origin main && git push origin v${version}\n` +
    `  git tag -l v${version} --format='%(contents:body)' | gh release create v${version} --title v${version} --notes-file -\n` +
    `Publishing the release moves \`production\` to v${version} (the production workflow), which downstream mirrors follow.\n`,
)
