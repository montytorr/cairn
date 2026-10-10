import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The switch is read on most requests and cached. A transient database error
 * must not read as "the Lab is off" — that would hide every subject for the
 * length of the cache — and a failed read must not be cached at all.
 */

const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: db.query }),
  normalizeDatabaseValue: (value: unknown) => value,
  transaction: vi.fn(),
}))

import { getLabSettings, invalidateLabSettings, reserveLabKey } from './lab-settings'

const on = { rows: [{ enabled: true, updated_at: '2026-10-10T20:00:00.000Z', project_id: null }] }
const error = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => {
  db.query.mockReset()
  invalidateLabSettings()
})

describe('getLabSettings', () => {
  it('reads the switch and caches it', async () => {
    db.query.mockResolvedValue(on)
    expect((await getLabSettings()).enabled).toBe(true)
    expect((await getLabSettings()).enabled).toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('reads a database without the table (before 071) as off', async () => {
    db.query.mockRejectedValue(error('42P01'))
    expect(await getLabSettings()).toMatchObject({ enabled: false })
  })

  it('throws any other error instead of answering off, and does not cache it', async () => {
    db.query.mockRejectedValueOnce(error('57P01')).mockResolvedValueOnce(on)
    await expect(getLabSettings()).rejects.toThrow('57P01')
    expect((await getLabSettings()).enabled).toBe(true)
    expect(db.query).toHaveBeenCalledTimes(2)
  })
})

describe('reserveLabKey', () => {
  it('says nothing once the reservation is in place', async () => {
    db.query.mockResolvedValue({ rows: [{ outcome: 'reserved' }] })
    expect(await reserveLabKey()).toBeUndefined()
  })

  it('warns, never throws, when the reservation cannot be added', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.query.mockResolvedValueOnce({ rows: [{ outcome: 'failed: must be owner of table projects' }] })
    expect(await reserveLabKey()).toMatch(/must be owner of table projects.*the API still refuses LAB/)
    db.query.mockRejectedValueOnce(error('42501'))
    expect(await reserveLabKey()).toMatch(/the API still refuses LAB/)
    db.query.mockResolvedValueOnce({ rows: [{ outcome: 'key_in_use' }] })
    expect(await reserveLabKey()).toMatch(/A project holds LAB/)
    warn.mockRestore()
  })
})
