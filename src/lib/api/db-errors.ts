import { fail, type ApiError } from './response'

/**
 * The handful of Postgres error codes worth distinguishing in an API response.
 * Anything not listed is a genuine 500 and should be logged, not translated
 * into a confident-sounding 4xx.
 */
const CODES: Record<string, { code: ApiError; message?: string }> = {
  '23505': { code: 'conflict' }, // unique_violation
  '23503': { code: 'validation_failed' }, // foreign_key_violation
  '23502': { code: 'validation_failed' }, // not_null_violation
  '23514': { code: 'validation_failed' }, // check_violation
}

export const failFromDb = (
  error: { code?: string; message: string },
  overrides: Partial<Record<string, string>> = {},
) => {
  const known = error.code ? CODES[error.code] : undefined
  if (!known) {
    console.error('[api] unexpected db error', error)
    return fail('internal_error', 'Something went wrong.')
  }
  return fail(known.code, overrides[error.code!] ?? error.message)
}
