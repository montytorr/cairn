import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Liveness probe. Deliberately does not touch the database: the container
 * healthcheck should report on the process, not on a dependency it cannot fix
 * by restarting.
 */
export const GET = () =>
  NextResponse.json({
    success: true,
    data: { status: 'ok', service: 'cairn', time: new Date().toISOString() },
  })
