import { describe, expect, it, vi, afterEach } from 'vitest'
import { messageFor, mutate, NETWORK_ERROR } from './mutate'

describe('messageFor', () => {
  it('reads the envelope error string', () => {
    expect(messageFor({ success: false, error: 'No task CAI-9999.', code: 'not_found' }, 404)).toBe(
      'No task CAI-9999.',
    )
  })

  it('unpacks the first validation issue, which the envelope hides', () => {
    // The top-level error for a schema failure is the useless literal
    // "Validation failed"; the half worth reading is in `issues`.
    const payload = {
      success: false,
      error: 'Validation failed',
      code: 'validation_failed',
      issues: [{ path: ['key'], message: 'Invalid' }],
    }
    expect(messageFor(payload, 400)).toBe('key: Invalid')
  })

  it('falls back to the issue alone when it has no path', () => {
    const payload = {
      success: false,
      error: 'Validation failed',
      code: 'validation_failed',
      issues: [{ path: [], message: 'Expected an object' }],
    }
    expect(messageFor(payload, 400)).toBe('Expected an object')
  })

  it('explains a signed-out tab, which has no envelope at all', () => {
    expect(messageFor(null, 401)).toContain('session has expired')
  })

  it('still says something when the body is not JSON', () => {
    expect(messageFor(null, 502)).toBe('Something went wrong (HTTP 502).')
  })
})

describe('mutate', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )

  it('returns the data on success', async () => {
    respond(200, { success: true, data: { number: 42 } })
    const result = await mutate<{ number: number }>('/api/v1/x', { method: 'POST', body: {} })
    expect(result).toEqual({ ok: true, data: { number: 42 } })
  })

  it('reports a refusal with its reason and code', async () => {
    respond(400, { success: false, error: 'Closing a task requires a resolution.', code: 'resolution_required' })
    const result = await mutate('/api/v1/x', { method: 'PATCH', body: {} })
    expect(result).toEqual({
      ok: false,
      error: 'Closing a task requires a resolution.',
      code: 'resolution_required',
    })
  })

  it('survives a thrown fetch rather than leaving the caller hanging', async () => {
    // This is the case no call site handled: the editor stuck on "Saving…"
    // and the dragged card that never rolled back.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const result = await mutate('/api/v1/x', { method: 'PATCH', body: {} })
    expect(result).toEqual({ ok: false, error: NETWORK_ERROR })
  })

  it('sends a JSON body with its content type, and a FormData body without one', async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, data: {} })),
    )
    vi.stubGlobal('fetch', spy)

    await mutate('/api/v1/x', { method: 'PATCH', body: { title: 'hi' } })
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"hi"}',
    })

    const form = new FormData()
    await mutate('/api/v1/x', { method: 'POST', form })
    // A multipart upload must set no content type — the browser writes the
    // boundary, and overriding it makes the body unparseable.
    expect(spy.mock.calls[1]?.[1]).not.toHaveProperty('headers')
  })
})
