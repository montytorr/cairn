import { NextResponse } from 'next/server'

export type ApiError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'already_claimed'
  | 'resolution_required'
  | 'rate_limited'
  | 'internal_error'

const STATUS: Record<ApiError, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  already_claimed: 409,
  resolution_required: 400,
  rate_limited: 429,
  internal_error: 500,
}

export const ok = <T>(data: T, init?: ResponseInit) =>
  NextResponse.json({ success: true, data }, init)

/**
 * Errors carry a machine-readable `code` and, where the failure is a bad
 * enum value, the list of valid ones. An agent that gets told what is
 * acceptable can retry correctly; one that just gets "400" cannot.
 */
export const fail = (code: ApiError, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ success: false, error, code, ...extra }, { status: STATUS[code] })

export const failValidation = (issues: unknown) =>
  NextResponse.json(
    { success: false, error: 'Validation failed', code: 'validation_failed', issues },
    { status: 400 },
  )
