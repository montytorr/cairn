import { readFileSync } from 'node:fs'
import { version as RELEASE } from '../../../../../package.json'
import { ok } from '@/lib/api/response'
import { BUILT_AT } from '@/lib/api/cli-fingerprint'

export const dynamic = 'force-dynamic'

/**
 * The commit this container was built from.
 *
 * Read once, at module load: the file is baked into the image by the
 * Dockerfile and cannot change while the process lives. Everything else that
 * could answer "is my fix live yet?" sits behind the login redirect, so the
 * only honest answer was to trust the deploy log.
 */
const build = (() => {
  try {
    return readFileSync('public/build-version.txt', 'utf8').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * Liveness probe. Deliberately does not touch the database: the container
 * healthcheck should report on the process, not on a dependency it cannot fix
 * by restarting.
 *
 * Goes through `ok()` rather than NextResponse so that it carries the same
 * version and CLI-fingerprint headers as every other route. It is the one
 * endpoint `cairn --version` calls, and it was the one endpoint that could not
 * answer "is my copy the current file?" (CAIRN-261). The body is unchanged:
 * `ok()` produces exactly the `{ success, data }` this already returned.
 */
export const GET = () =>
  ok({
    status: 'ok',
    service: 'cairn',
    // The released version, and the exact commit it was built from. The
    // first tells a CLI whether it is out of step; the second tells a human
    // whether their fix is live.
    version: RELEASE,
    build,
    builtAt: BUILT_AT,
    time: new Date().toISOString(),
  })
