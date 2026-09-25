import { describe, expect, it } from 'vitest'
import { filesNamedIn, UNVERIFIED_DAYS, unverifiedDaysFor } from './staleness'

describe('filesNamedIn', () => {
  it('finds the backticked paths a fact is about', () => {
    expect(filesNamedIn('See `src/lib/db/client.ts` and `migrations/015_file_touches.sql`.')).toEqual([
      'src/lib/db/client.ts',
      'migrations/015_file_touches.sql',
    ])
  })

  it('ignores a command that happens to be in backticks', () => {
    // `cairn check` is in almost every entry; reading it as a file would make
    // every fact depend on a path nothing ever touches.
    expect(filesNamedIn('Start with `cairn check "<subject>"`, then `npm test`.')).toEqual([])
  })

  it('ignores a repo slug, which looks exactly like a short path', () => {
    expect(filesNamedIn('The remote is `montytorr/cairn` on GitHub.')).toEqual([])
  })

  it('does not invent files from prose', () => {
    expect(filesNamedIn('The service-role client bypasses RLS, so filter by owner.')).toEqual([])
  })

  it('counts a path once however often it is named', () => {
    expect(filesNamedIn('`a/b.ts` then `a/b.ts` again')).toEqual(['a/b.ts'])
  })

  it('reads a bare filename as prose, since a name without a path is ambiguous', () => {
    expect(filesNamedIn('Defined in `client.ts`.')).toEqual([])
  })

  it('accepts a home-relative path, which is the one real path this store holds', () => {
    // An earlier regex required the first segment to be a word character, so
    // `~/.cairn/projects.json` was rejected — and it is the only genuine file
    // path in Cairn's own knowledge. The feature would have been inert while
    // looking like it worked.
    expect(filesNamedIn('The map lives at `~/.cairn/projects.json`.')).toEqual([
      '~/.cairn/projects.json',
    ])
    expect(filesNamedIn('Installed to `/usr/local/bin/cairn.mjs`.')).toEqual([
      '/usr/local/bin/cairn.mjs',
    ])
  })

  it('still refuses a SQL signature, which is what these bodies are full of', () => {
    expect(filesNamedIn('`to_tsvector(regconfig, text)` is only STABLE.')).toEqual([])
  })
})

describe('unverifiedDaysFor', () => {
  const now = Date.parse('2026-09-25T12:00:00Z')
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString()

  it('marks a fact with no files once nobody has confirmed it for the window', () => {
    expect(unverifiedDaysFor({ created_at: daysAgo(UNVERIFIED_DAYS + 1) }, 0, now)).toBe(UNVERIFIED_DAYS + 1)
  })

  it('stays quiet inside the window', () => {
    expect(unverifiedDaysFor({ created_at: daysAgo(UNVERIFIED_DAYS - 1) }, 0, now)).toBeNull()
  })

  it('counts from the last verification, not the first write', () => {
    expect(
      unverifiedDaysFor({ created_at: daysAgo(40), verified_at: daysAgo(2) }, 0, now),
    ).toBeNull()
  })

  it('leaves facts that name files to the file-based signal', () => {
    // Two marks for one entry would read as two kinds of evidence; only one is.
    expect(unverifiedDaysFor({ created_at: daysAgo(90) }, 1, now)).toBeNull()
  })

  it('says nothing when it cannot tell the age', () => {
    expect(unverifiedDaysFor({ created_at: null }, 0, now)).toBeNull()
  })
})
