import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), buildContext: vi.fn() }))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api/context')>(),
  buildContext: mocks.buildContext,
}))

import { ContextProjectNotFoundError, ContextScopeError } from '@/lib/api/context'
import { GET } from './route'

const actor = {
  userId: 'user-1', actorType: 'agent', actorId: 'agent-1', role: 'member',
  userDisplayName: 'Agent', rateKey: `context-route-${Math.random()}`, sessionId: null,
}

const context = (query: string) => GET(
  new Request(`https://cairn.example.test/api/v1/context?${query}`),
  { params: Promise.resolve({}) },
)

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue(actor)
  mocks.buildContext.mockReset()
})

it('returns 404 when an explicit project key does not exist in project scope', async () => {
  mocks.buildContext.mockRejectedValue(new ContextProjectNotFoundError())
  const response = await context('scope=project&project=TYPO')
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ success: false, code: 'not_found' })
  expect(mocks.buildContext).toHaveBeenCalledWith(actor, expect.objectContaining({
    scope: 'project', project: 'TYPO',
  }))
})

it('still returns 400 when no project can be resolved', async () => {
  mocks.buildContext.mockRejectedValue(new ContextScopeError())
  const response = await context('scope=project')
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ success: false, code: 'validation_failed' })
})
