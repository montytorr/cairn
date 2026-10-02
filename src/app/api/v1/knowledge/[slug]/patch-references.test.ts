import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getKnowledge: vi.fn(),
  updateKnowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
  referenceCorpus: vi.fn(),
  liveReferrers: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/knowledge', () => ({
  getKnowledge: mocks.getKnowledge,
  updateKnowledge: mocks.updateKnowledge,
  deleteKnowledge: mocks.deleteKnowledge,
}))

vi.mock('@/lib/api/search-events', () => ({
  recordKnowledgeRead: vi.fn(),
  recordSearch: vi.fn(),
}))

vi.mock('@/lib/api/activity', () => ({ recordActivity: vi.fn() }))

// Keep the real resolver — it is what is under test — and stub only the store.
vi.mock('@/lib/api/knowledge-graph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/knowledge-graph')>()),
  referenceCorpus: mocks.referenceCorpus,
  liveReferrers: mocks.liveReferrers,
}))

import { DELETE, PATCH } from './route'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: `knowledge-patch-${Math.random()}`,
  sessionId: null,
}

const patch = (slug: string, body: unknown) =>
  PATCH(
    new Request(`https://cairn.example.test/api/v1/knowledge/${slug}`, {
      method: 'PATCH',
      // Bearer, so the browser-origin guard takes its short-circuit branch.
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  )

const remove = (slug: string, query = '') =>
  DELETE(
    new Request(`https://cairn.example.test/api/v1/knowledge/${slug}${query}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-key' },
    }),
    { params: Promise.resolve({ slug }) },
  )

/** What the entry says before the edit: debris from before the check existed. */
const STORED = 'Old: [[borrower-insurance-appointments]] and [[BB-192]].'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticate.mockResolvedValue({ ok: true, actor })
  mocks.getKnowledge.mockResolvedValue({ slug: 'a-fact', title: 'A fact', body: 'Plain.' })
  mocks.updateKnowledge.mockResolvedValue({ slug: 'a-fact', title: 'A fact' })
  mocks.deleteKnowledge.mockResolvedValue(true)
  mocks.liveReferrers.mockResolvedValue([])
  // The store holds the prefixed spelling; an edit guessing the bare one is
  // the exact 63% case. `old-fact` was replaced by `new-fact`.
  mocks.referenceCorpus.mockResolvedValue({
    known: ['project-borrower-insurance-appointments', 'a-fact', 'old-fact', 'new-fact'],
    successors: new Map([['old-fact', 'new-fact']]),
  })
})

/**
 * POST resolved references and PATCH did not, which left the whole check
 * reachable in one hop: write a clean entry, then edit a dangling reference
 * into it with nothing looking.
 */
describe('PATCH /api/v1/knowledge/[slug]', () => {
  it('refuses an edit that introduces a reference the store already holds elsewhere', async () => {
    const res = await patch('a-fact', { body: 'see [[borrower-insurance-appointments]]' })
    expect(res.status).toBe(400)
    const payload = await res.json()
    expect(payload.success).toBe(false)
    expect(JSON.stringify(payload)).toContain('project-borrower-insurance-appointments')
    expect(mocks.updateKnowledge).not.toHaveBeenCalled()
  })

  it('lets the edit through when the caller insists', async () => {
    const res = await patch('a-fact', {
      body: 'see [[borrower-insurance-appointments]]',
      allowUnresolvedRefs: true,
    })
    expect(res.status).toBe(200)
    expect(mocks.updateKnowledge).toHaveBeenCalled()
  })

  it('does not re-check a body it is not changing', async () => {
    const res = await patch('a-fact', { verified: true })
    expect(res.status).toBe(200)
    expect(mocks.updateKnowledge).toHaveBeenCalled()
  })

  /**
   * The web editor sends the whole body on every save. Checking all of it
   * refused a one-paragraph fix over references the entry has carried since
   * before the check existed (CAIRN-347).
   */
  it('passes references the stored body already carried', async () => {
    mocks.getKnowledge.mockResolvedValue({ slug: 'a-fact', title: 'A fact', body: STORED })

    const res = await patch('a-fact', { body: `${STORED}\n\nA corrected paragraph.` })

    expect(res.status).toBe(200)
    expect(mocks.updateKnowledge).toHaveBeenCalled()
    expect((await res.json()).data.warnings).toBeUndefined()
  })

  it('still refuses a task ref in wiki brackets the edit adds beside them', async () => {
    mocks.getKnowledge.mockResolvedValue({ slug: 'a-fact', title: 'A fact', body: STORED })

    const res = await patch('a-fact', { body: `${STORED} Fixed in [[CAIRN-347]].` })

    expect(res.status).toBe(400)
    expect((await res.json()).taskReferences).toEqual(['CAIRN-347'])
    expect(mocks.updateKnowledge).not.toHaveBeenCalled()
  })

  it('warns, naming the successor, when the edit adds a reference to a superseded entry', async () => {
    const res = await patch('a-fact', { body: 'see [[old-fact]]' })

    expect(res.status).toBe(200)
    expect((await res.json()).data.warnings).toEqual([
      '[[old-fact]] is superseded by [[new-fact]] — point at the successor, unless the old claim is what you mean.',
    ])
  })
})

/**
 * Deleting an entry other entries reference turned each of those references
 * into one pointing at nothing, without a word (CAIRN-347).
 */
describe('DELETE /api/v1/knowledge/[slug]', () => {
  it('refuses while live entries reference it, naming them', async () => {
    mocks.liveReferrers.mockResolvedValue(['nginx-tuning', 'proxy-notes'])

    const res = await remove('a-fact')

    expect(res.status).toBe(409)
    const payload = await res.json()
    expect(payload).toMatchObject({
      success: false,
      code: 'conflict',
      referrers: ['nginx-tuning', 'proxy-notes'],
      referrerCount: 2,
    })
    expect(payload.error).toContain('[[nginx-tuning]], [[proxy-notes]]')
    expect(payload.error).toContain('--superseded-by')
    expect(mocks.deleteKnowledge).not.toHaveBeenCalled()
  })

  it('deletes anyway when the caller insists', async () => {
    mocks.liveReferrers.mockResolvedValue(['nginx-tuning'])

    const res = await remove('a-fact', '?allowUnresolvedRefs=true')

    expect(res.status).toBe(200)
    expect(mocks.liveReferrers).not.toHaveBeenCalled()
    expect(mocks.deleteKnowledge).toHaveBeenCalled()
  })

  it('deletes an entry nothing references', async () => {
    const res = await remove('a-fact')

    expect(res.status).toBe(200)
    expect(mocks.liveReferrers).toHaveBeenCalledWith('a-fact')
    expect(mocks.deleteKnowledge).toHaveBeenCalled()
  })

  it('still 404s an entry that does not exist, without scanning for referrers', async () => {
    mocks.getKnowledge.mockResolvedValue(null)
    mocks.deleteKnowledge.mockResolvedValue(false)

    const res = await remove('nothing-here')

    expect(res.status).toBe(404)
    expect(mocks.liveReferrers).not.toHaveBeenCalled()
  })
})
