#!/usr/bin/env node
/**
 * Moves a Croft database into a Cairn instance that has the Lab (CAIRN-369).
 *
 *   node scripts/import-croft.mjs --croft <url> --target <url>            # dry run
 *   node scripts/import-croft.mjs --croft <url> --target <url> --apply    # writes
 *
 * Croft is read, never written. The target gets one transaction: users,
 * stages, tags, lab projects, subjects with their log, notes and files, then
 * the todos as tasks with their notes, comments and history. A dry run is the
 * same code, rolled back, so it fails on exactly what a real run would fail on.
 *
 * The connection strings are arguments on purpose. Nothing here knows where
 * production is, so nothing here can reach it by accident.
 *
 * docs/lab-import.md is the runbook.
 */
import { open, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { checkSource, removeFiles, storesFromOptions } from './import-croft/files.mjs'
import { buildPlan, DEFAULTS, parseProjectKeys } from './import-croft/plan.mjs'
import { buildReport, renderReport } from './import-croft/report.mjs'
import { rawTypes, readCroft } from './import-croft/read.mjs'
import { readTarget, writePlan } from './import-croft/write.mjs'

const USAGE = `Usage: node scripts/import-croft.mjs --croft <url> --target <url> [--apply] [options]

  --croft <url>                 the Croft database (read only)
  --target <url>                the Cairn database, migrated to the Lab, holding no subjects
  --apply                       write. Without it, the whole import runs and is rolled back.

  --mapping-file <path>         write the S-n -> LAB-n and T-n -> new ref mapping (JSON)
  --report-file <path>          write the report as JSON
  --json                        print the report as JSON
  --owner <email>               who owns the projects created (default: the first admin)
  --home-key <KEY>              the Lab's todo home project (default ${DEFAULTS.homeKey})
  --project-key "<name>=<KEY>"  the Cairn key of a lab project, repeatable. Needed for a
                                lab project whose hand-off is not a cairn project key.
  --cairn-url <url>             where hand-offs to cairn live (default ${DEFAULTS.cairnUrl})
  --croft-host <host>           written into each todo's external_ref (default ${DEFAULTS.croftHost})
  --allow-private               import subjects that were private or members-only in Croft
  --rewrite-refs                rewrite S-n and T-n written in prose to LAB-n and the new ref
  --no-enable-lab               leave the Lab switched off

  --croft-files-dir <dir>       Croft's attachment directory
  --croft-files-s3-bucket <b>   ... or its S3 bucket (--croft-files-s3-prefix <p>)
  --target-files-dir <dir>      the target's attachment directory
  --target-files-s3-bucket <b>  ... or its S3 bucket (--target-files-s3-prefix <p>)
`

const sameDatabase = async (a, b) => {
  const probe = async (client) =>
    (
      await client.query(
        `select current_database() as db, (select system_identifier::text from pg_control_system()) as sys`,
      )
    ).rows[0]
  const [x, y] = await Promise.all([probe(a), probe(b)])
  return x.db === y.db && x.sys === y.sys
}

const shortError = (error) => {
  const parts = [error.message]
  if (error.detail) parts.push(error.detail)
  if (error.constraint) parts.push(`(constraint ${error.constraint})`)
  if (error.table) parts.push(`(table ${error.table})`)
  return parts.join(' ')
}

/**
 * @returns {Promise<{ report: object, text: string, mapping: object | null, exitCode: number }>}
 */
export const importCroft = async ({
  croftUrl,
  targetUrl,
  apply = false,
  options = {},
  stores = null,
  mappingFile = null,
  log = () => {},
}) => {
  const mode = apply ? 'apply' : 'dry-run'
  const finish = (report, mapping = null) => ({
    report,
    text: renderReport(report),
    mapping,
    exitCode: report.verdict === 'blocked' ? 1 : 0,
  })
  const blocked = (errors, plan = null) => finish(buildReport({ plan, mode, source: croftUrl, target: targetUrl, blocked: errors }))

  if (!croftUrl || !targetUrl) return blocked(['--croft and --target are both required'])
  if (croftUrl === targetUrl) return blocked(['--croft and --target are the same connection string'])

  const parsedKeys = parseProjectKeys(options.projectKeyPairs)
  if (parsedKeys.errors.length) return blocked(parsedKeys.errors)

  // Claim the mapping file's name before anything is written, so a typo or an
  // existing file fails now and not after the commit.
  let mappingHandle = null
  if (mappingFile) {
    try {
      mappingHandle = await open(mappingFile, 'wx')
    } catch (error) {
      return blocked([`--mapping-file ${mappingFile}: ${error.code === 'EEXIST' ? 'already exists' : error.message}`])
    }
  }
  const dropMappingFile = async () => {
    if (!mappingHandle) return
    await mappingHandle.close().catch(() => {})
    await rm(mappingFile, { force: true })
    mappingHandle = null
  }

  const croft = new pg.Client({ connectionString: croftUrl, types: rawTypes })
  const target = new pg.Client({ connectionString: targetUrl })
  let targetOpen = false
  let copied = []
  try {
    await croft.connect()
    await target.connect()
    if (await sameDatabase(croft, target)) {
      await dropMappingFile()
      return blocked(['--croft and --target are the same database'])
    }

    log('reading Croft')
    const snapshot = await readCroft(croft)
    if (snapshot.problems.length) {
      await dropMappingFile()
      return blocked(snapshot.problems)
    }

    await target.query('begin')
    targetOpen = true
    const facts = await readTarget(target)
    if (facts.problems.length) {
      await target.query('rollback')
      targetOpen = false
      await dropMappingFile()
      return blocked(facts.problems)
    }
    if (facts.subjectCount > 0) {
      await target.query('rollback')
      targetOpen = false
      await dropMappingFile()
      return blocked([
        `the target already holds ${facts.subjectCount} subject(s). An import goes into an instance with none: restore a backup or start from a fresh database.`,
      ])
    }

    const plan = buildPlan({
      croft: snapshot,
      target: facts,
      options: {
        ownerEmail: options.owner,
        homeKey: options.homeKey ?? DEFAULTS.homeKey,
        cairnUrl: options.cairnUrl ?? DEFAULTS.cairnUrl,
        croftHost: options.croftHost ?? DEFAULTS.croftHost,
        projectKeys: parsedKeys.keys,
        allowPrivate: Boolean(options.allowPrivate),
        rewriteRefs: Boolean(options.rewriteRefs),
        enableLab: options.enableLab !== false,
      },
    })

    let fileStats = null
    if (plan.files.length) {
      const bytes = plan.files.reduce((n, f) => n + f.size, 0)
      fileStats = { count: plan.files.length, bytes, checked: false }
      if (!stores?.source) {
        plan.errors.push(
          `${plan.files.length} attachment file(s) must be copied and no source store is given: pass --croft-files-dir or --croft-files-s3-bucket`,
        )
      } else {
        const { problems } = await checkSource(stores.source, plan.files)
        plan.errors.push(...problems)
        fileStats.checked = true
      }
      if (apply && !stores?.target) {
        plan.errors.push('--apply with attachments needs a target store: pass --target-files-dir or --target-files-s3-bucket')
      }
    }

    if (plan.errors.length) {
      await target.query('rollback')
      targetOpen = false
      await dropMappingFile()
      return finish(buildReport({ plan, mode, source: croftUrl, target: targetUrl, fileStats }))
    }

    log('writing to the target')
    let result
    try {
      result = await writePlan({ client: target, plan, target: facts, apply, stores, log })
    } catch (error) {
      await target.query('rollback')
      targetOpen = false
      await dropMappingFile()
      plan.errors.push(`the target refused the import: ${shortError(error)}`)
      return finish(buildReport({ plan, mode, source: croftUrl, target: targetUrl, fileStats }))
    }
    copied = result.written

    if (result.verification.some((v) => !v.ok)) {
      await target.query('rollback')
      targetOpen = false
      await removeFiles({ target: stores?.target, paths: copied })
      await dropMappingFile()
      plan.errors.push('verification failed after writing; the import was rolled back')
      return finish(
        buildReport({ plan, mode, source: croftUrl, target: targetUrl, fileStats, verification: result.verification }),
      )
    }

    if (apply) {
      await target.query('commit')
      targetOpen = false
      copied = []
    } else {
      await target.query('rollback')
      targetOpen = false
    }

    const mapping = {
      applied: apply,
      source_host: plan.options.croftHost,
      generated_at: new Date().toISOString(),
      subjects: plan.mapping.subjects,
      todos: plan.mapping.todos,
      external_refs: Object.fromEntries(
        Object.entries(plan.mapping.todos).map(([from, to]) => [`croft:${plan.options.croftHost}/${from}`, to]),
      ),
    }
    if (mappingHandle) {
      await mappingHandle.writeFile(`${JSON.stringify(mapping, null, 2)}\n`)
      await mappingHandle.close()
      mappingHandle = null
    }
    return finish(
      buildReport({
        plan,
        mode,
        source: croftUrl,
        target: targetUrl,
        verification: result.verification,
        written: result.written.length,
        fileStats,
      }),
      mapping,
    )
  } catch (error) {
    if (targetOpen) await target.query('rollback').catch(() => {})
    if (copied.length && stores?.target) await removeFiles({ target: stores.target, paths: copied })
    await dropMappingFile()
    throw error
  } finally {
    await croft.end().catch(() => {})
    await target.end().catch(() => {})
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      croft: { type: 'string' },
      target: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'mapping-file': { type: 'string' },
      'report-file': { type: 'string' },
      json: { type: 'boolean', default: false },
      owner: { type: 'string' },
      'home-key': { type: 'string' },
      'project-key': { type: 'string', multiple: true },
      'cairn-url': { type: 'string' },
      'croft-host': { type: 'string' },
      'allow-private': { type: 'boolean', default: false },
      'rewrite-refs': { type: 'boolean', default: false },
      'no-enable-lab': { type: 'boolean', default: false },
      'croft-files-dir': { type: 'string' },
      'croft-files-s3-bucket': { type: 'string' },
      'croft-files-s3-prefix': { type: 'string' },
      'target-files-dir': { type: 'string' },
      'target-files-s3-bucket': { type: 'string' },
      'target-files-s3-prefix': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || (!values.croft && !values.target)) {
    console.log(USAGE)
    return 0
  }

  const stores = storesFromOptions({
    croftFilesDir: values['croft-files-dir'],
    croftFilesS3Bucket: values['croft-files-s3-bucket'],
    croftFilesS3Prefix: values['croft-files-s3-prefix'],
    targetFilesDir: values['target-files-dir'],
    targetFilesS3Bucket: values['target-files-s3-bucket'],
    targetFilesS3Prefix: values['target-files-s3-prefix'],
  })

  const { report, text, exitCode } = await importCroft({
    croftUrl: values.croft,
    targetUrl: values.target,
    apply: values.apply,
    stores,
    mappingFile: values['mapping-file'] ?? null,
    log: (m) => console.error(`  ${m}`),
    options: {
      owner: values.owner,
      homeKey: values['home-key'],
      projectKeyPairs: values['project-key'],
      cairnUrl: values['cairn-url'],
      croftHost: values['croft-host'],
      allowPrivate: values['allow-private'],
      rewriteRefs: values['rewrite-refs'],
      enableLab: !values['no-enable-lab'],
    },
  })

  if (values['report-file']) {
    const handle = await open(values['report-file'], 'w')
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    await handle.close()
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : text)
  if (values['mapping-file'] && exitCode === 0) console.error(`mapping written to ${values['mapping-file']}`)
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
