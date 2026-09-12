/**
 * One way to make a write from the browser.
 *
 * Every call site used to hand-roll this, and about half got it wrong: some
 * never checked `res.ok`, some reverted optimistic state with no message, and
 * two read `json.error.message` when the envelope carries `error` as a plain
 * string — so the one place with a precise server message ("that would be a
 * loop") always showed its generic fallback instead.
 *
 * The other half of the problem was invisible: not one call site wrapped the
 * fetch in a try/catch. A dropped connection left the description editor stuck
 * on "Saving…" forever and left dragged cards in lanes they were never moved
 * to, because the rollback line never ran.
 */

export type Mutation<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

export const NETWORK_ERROR = 'Could not reach the server — nothing was saved.'

type Issue = { path?: (string | number)[]; message?: string }

/**
 * Turns a response body into something worth showing a person.
 *
 * Schema failures arrive as the literal string "Validation failed" with the
 * detail in `issues`, which no call site read — so typing "Business Unit" as
 * an entity key said only that it was invalid, never that keys are
 * lowercase-and-hyphens. The first issue is the one that gets shown: they are
 * ordered by field, and a wall of them helps nobody.
 */
export const messageFor = (payload: unknown, status: number): string => {
  const body = (payload ?? {}) as { error?: unknown; code?: string; issues?: Issue[] }

  if (body.code === 'validation_failed' && Array.isArray(body.issues)) {
    const [first] = body.issues
    if (first?.message) {
      const field = first.path?.filter((p) => p !== '').join('.')
      return field ? `${field}: ${first.message}` : first.message
    }
  }

  if (typeof body.error === 'string' && body.error.trim()) return body.error

  // Some failures never reach a route handler — a proxy timeout, or a signed
  // out tab redirected to the login page — so there is no envelope to read.
  if (status === 401) return 'Your session has expired. Reload the page and sign in again.'
  if (status === 413) return 'That file is too large.'
  return `Something went wrong (HTTP ${status}).`
}

type Init = {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Serialised as JSON. Use `form` for uploads. */
  body?: unknown
  form?: FormData
  signal?: AbortSignal
}

export const mutate = async <T = unknown>(url: string, init: Init): Promise<Mutation<T>> => {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method,
      ...(init.form
        ? { body: init.form }
        : init.body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
          : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    })
  } catch {
    return { ok: false, error: NETWORK_ERROR }
  }

  const payload = await res.json().catch(() => null)
  const body = (payload ?? {}) as { success?: boolean; data?: T; error?: unknown; code?: string }

  // `success: false` with a 200 is not a shape this API produces, but reading
  // both is what lets a call site stop caring which one it got.
  if (!res.ok || body.success === false) {
    return { ok: false, error: messageFor(payload, res.status), code: body.code }
  }
  return { ok: true, data: body.data as T }
}
