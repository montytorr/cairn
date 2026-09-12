import { readFileSync } from 'node:fs'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * The commit this container was built from.
 *
 * Read once, at module load: the file is baked into the image by the
 * Dockerfile and cannot change while the process lives. Everything else that
 * could answer "is my fix live yet?" sits behind the login redirect, so the
 * only honest answer was to trust the deploy log.
 */
const version = (() => {
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
 */
export const GET = () =>
  NextResponse.json({
    success: true,
    data: { status: 'ok', service: 'cairn', version, time: new Date().toISOString() },
  })
