import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }))

vi.mock('./auth', () => ({ authenticate: mocks.authenticate }))

import { route } from './handler'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: `secrets-${Math.random()}`,
  sessionId: null,
}

// Built at runtime so this file is not itself a finding for a secret scanner.
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`

const handler = vi.fn(async () => new Response('{}'))
const POST = route({
  schema: z.object({ title: z.string(), body: z.string(), labels: z.array(z.string()).default([]) }),
  secretFields: ['title', 'body'],
  handler,
})

const send = (body: unknown) =>
  POST(
    new Request('https://cairn.example.test/api/v1/knowledge', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  )

describe('route secretFields (CAIRN-285)', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    handler.mockClear()
  })

  it('refuses a secret in a named field with 400 secret_detected, never echoing it', async () => {
    const response = await send({ title: 'GitHub access', body: `line one\ntoken is ${TOKEN}` })
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      code: 'secret_detected',
      field: 'body',
      pattern: 'github_token',
      line: 2,
    })
    expect(text).not.toContain(TOKEN)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not look at fields it was not told to', async () => {
    const response = await send({ title: 'fine', body: 'fine too', labels: [TOKEN] })
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('lets a placeholder through', async () => {
    const response = await send({ title: 'DB login', body: 'password: $DB_PASSWORD (see the vault)' })
    expect(response.status).toBe(200)
  })
})
