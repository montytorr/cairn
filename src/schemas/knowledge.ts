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
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '')

export const knowledgeCreate = z.object({
  slug: knowledgeSlug.optional(),
  title: z.string().min(1).max(300),
  body: z.string().max(100_000).default(''),
  labels: z.array(z.string().min(1).max(40)).max(20).default([]),
  projects: z.array(z.string().min(1).max(10)).max(20).default([]),
  sourceTaskRef: z.string().max(40).optional(),
  sourceSessionId: z.string().uuid().optional(),
  verified: z.boolean().optional(),
})

/**
 * Fields only. `.partial()` on a schema carrying `.default()` keeps the
 * default and quietly overwrites the column on every PATCH — the same trap
 * documented at length in schemas/task.ts.
 */
export const knowledgeUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(100_000).optional(),
  labels: z.array(z.string().min(1).max(40)).max(20).optional(),
  projects: z.array(z.string().min(1).max(10)).max(20).optional(),
  supersededBy: z.string().max(120).nullable().optional(),
  verified: z.boolean().optional(),
})

export const actorType = z.enum(ACTOR_TYPES)

export type KnowledgeCreate = z.infer<typeof knowledgeCreate>
export type KnowledgeUpdate = z.infer<typeof knowledgeUpdate>
