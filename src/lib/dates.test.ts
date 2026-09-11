import { describe, expect, it } from 'vitest'
import { fullDateTime, relativeTime, shortDate, timeOfDay } from './dates'

/**
 * The bug these guard against: an unpinned `toLocaleDateString` formats in the
 * runtime's zone, so the container (UTC) and the browser (CEST) disagreed on
 * any timestamp near midnight — one React hydration error per offending row.
 */
describe('date formatting', () => {
  // 23:30 UTC on the 29th is 01:30 on the 30th in Europe/Paris. An unpinned
  // formatter returns a different day depending on where it runs; this must
  // not.
  const nearMidnight = '2026-04-29T23:30:00.000Z'

  it('pins the zone, so the same input always gives the same string', () => {
    const runs = Array.from({ length: 3 }, () => shortDate(nearMidnight))
    expect(new Set(runs).size).toBe(1)
  })

  it('formats in the display zone, not the runtime zone', () => {
    // Europe/Paris is a day ahead of UTC at this instant.
    expect(shortDate(nearMidnight)).toBe('30 Apr')
  })

  it('is unaffected by the process timezone', () => {
    const before = process.env.TZ
    process.env.TZ = 'Pacific/Auckland'
    try {
      expect(shortDate(nearMidnight)).toBe('30 Apr')
    } finally {
      process.env.TZ = before
    }
  })

  it('includes the time in the tooltip form', () => {
    expect(fullDateTime(nearMidnight)).toMatch(/30 Apr 2026, 01:30/)
  })

  it('formats a bare time in the display zone, for the sessions timeline', () => {
    expect(timeOfDay(nearMidnight)).toBe('01:30')
  })

  describe('relativeTime', () => {
    const base = new Date('2026-09-10T12:00:00.000Z').getTime()
    const at = (offsetSeconds: number) =>
      relativeTime(new Date(base - offsetSeconds * 1000).toISOString(), base)

    it.each([
      [10, 'just now'],
      [300, '5m ago'],
      [7200, '2h ago'],
      [86_400 * 3, '3d ago'],
    ])('renders %ss ago as %s', (seconds, expected) => {
      expect(at(seconds)).toBe(expected)
    })

    it('falls back to an absolute date beyond a week', () => {
      expect(at(86_400 * 30)).toBe('11 Aug')
    })

    // Pure, so a component can render the absolute form on the server and the
    // relative form after mount without the two disagreeing.
    it('takes now as an argument rather than reading the clock', () => {
      const iso = new Date(base - 600_000).toISOString()
      expect(relativeTime(iso, base)).toBe('10m ago')
      expect(relativeTime(iso, base + 3_600_000)).toBe('1h ago')
    })
  })
})
