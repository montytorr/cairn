import { NextResponse } from 'next/server'
import { openapiSpec } from '@/lib/api/openapi'

export const dynamic = 'force-dynamic'

/** Public: an API description is not a secret, and agents fetch it before authenticating. */
export const GET = () =>
  NextResponse.json(openapiSpec(), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
