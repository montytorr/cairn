import { z } from 'zod'
import { ACTOR_TYPES } from './task'

/**
 * Knowledge is what we know; a task is what we did. The vocabulary is
 * deliberately thin — a slug, a title, a body and labels — because the store
 * this replaces grew 200+ free-text `type` values, of which one absorbed
 * 15,342 of 29,090 rows. A taxonomy nobody maintains is not a taxonomy.
 */

/** Lowercase, hyphen-separated, no leading or trailing hyphen. Matches the CHECK in 013. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const knowledgeSlug = z
  .string()
  .min(3)
  .max(120)
  .regex(SLUG_PATTERN, 'Use lowercase words separated by single hyphens.')

/**
 * Derives a slug from a title, so callers can write knowledge without
 * inventing an identifier. Collisions are the caller's to resolve — silently
 * appending a number would produce `postgres-gotcha-2`, which tells a later
 * reader nothing about how it differs from `postgres-gotcha`.
 */
const MAX_SLUG = 120

export const slugify = (title: string): string => {
  const full = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (full.length <= MAX_SLUG) return full

  // Cut at the last whole word inside the cap, not through one. Slicing at the
  // character produced twelve identifiers ending mid-word — `...cannot-sha`,
  // `...dernier-passag`, `...claude-c` — which cannot be typed, cannot be
  // guessed, and read as corrupt in a URL.
  const head = full.slice(0, MAX_SLUG)
  const lastWord = head.lastIndexOf('-')
  // A title with no break at all in 120 characters still has to yield
  // something; a hard cut beats an empty slug, which the caller treats as
  // "could not derive one".
  return (lastWord > 0 ? head.slice(0, lastWord) : head).replace(/-+$/, '')
}

/**
 * What somebody meant when they wrote a slug down.
 *
 * Knowledge bodies cross-reference each other as `[[some-slug]]`, and 365 of
 * the 625 such references in the store spell the separator with underscores
 * while every one of the 377 real slugs uses hyphens — the convention came in
 * wholesale with the claude-mem import and nothing reconciled the two.
 *
 * That is not cosmetic. `cairn know <subject>` only attempts a fetch when the
 * subject looks like a slug, so an underscore spelling fell through to
 * full-text search and could miss the entry entirely while looking like an
 * answer. Normalising on lookup makes both spellings resolve without
 * rewriting anything anybody wrote.
 *
 * Deliberately narrow: case and separator only. Anything cleverer — stripping
 * words, fuzzy matching — would resolve a reference to something its author
 * did not mean, which is worse than not resolving it.
 */
export const normalizeSlugRef = (raw: string): string =>
  raw.trim().toLowerCase().replace(/_/g, '-')

/**
 * A body is required and must say something (CAIRN-289).
 *
 * It defaulted to '' and the CLI sent `flags.body ?? ''`, so a fact could be
 * filed as a bare title — two were, and they read in every list exactly like
 * an entry with an explanation behind it. Checked rather than trimmed: what an
 * author wrote is stored as written.
 */
const knowledgeBody = z
  .string()
  .max(100_000)
  .refine((body) => body.trim().length > 0, {
    message: 'A fact needs a body: what it means and how it was found. Pass it with --body (or --body - for stdin).',
  })

export const knowledgeCreate = z.object({
  slug: knowledgeSlug.optional(),
  title: z.string().min(1).max(300),
  body: knowledgeBody,
  labels: z.array(z.string().min(1).max(40)).max(20).default([]),
  projects: z.array(z.string().min(1).max(10)).max(20).default([]),
  /** Groupings this is true of — a business, a stack, a subsystem. */
  entities: z.array(z.string().min(1).max(40)).max(20).default([]),
  /** Files this is about, beyond the paths its body names (CAIRN-269). */
  files: z.array(z.string().min(1).max(500)).max(50).optional(),
  sourceTaskRef: z.string().max(40).optional(),
  sourceSessionId: z.string().uuid().optional(),
  verified: z.boolean().optional(),
  /**
   * Record the entry even though one of its `[[refs]]` names an entry that
   * does not exist and one that nearly does.
   *
   * The write path refuses that case, because 63% of the store's dangling
   * references point at a fact it already holds under another name. This is
   * the way out for the other case — two entries that cite each other cannot
   * both be written first — and it is deliberately something the caller has to
   * say, so "the reference is fine as it is" is a claim somebody made rather
   * than a default nobody noticed.
   */
  allowUnresolvedRefs: z.boolean().optional(),
})

/**
 * Fields only. `.partial()` on a schema carrying `.default()` keeps the
 * default and quietly overwrites the column on every PATCH — the same trap
 * documented at length in schemas/task.ts.
 */
export const knowledgeUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  body: knowledgeBody.optional(),
  labels: z.array(z.string().min(1).max(40)).max(20).optional(),
  projects: z.array(z.string().min(1).max(10)).max(20).optional(),
  entities: z.array(z.string().min(1).max(40)).max(20).optional(),
  supersededBy: z.string().max(120).nullable().optional(),
  verified: z.boolean().optional(),
  allowUnresolvedRefs: z.boolean().optional(),
  /** Replaces the files named explicitly; body and source links are kept up by the database. */
  files: z.array(z.string().min(1).max(500)).max(50).optional(),
  /** Why the entry changed. Kept on the revision the edit produces. */
  reason: z.string().min(1).max(500).optional(),
})

export const actorType = z.enum(ACTOR_TYPES)

export type KnowledgeCreate = z.infer<typeof knowledgeCreate>
export type KnowledgeUpdate = z.infer<typeof knowledgeUpdate>
