import type { Tag } from './types'

/** Tags whose name contains the query, any case; all of them for an empty query. */
export const filterTags = <T extends Pick<Tag, 'name'>>(tags: T[], query: string): T[] => {
  const q = query.trim().toLowerCase()
  return q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags
}

/**
 * The name an administrator's query would create, or null when there is
 * nothing to create: an empty query, one over the 40-character limit, or one
 * that already names a tag. Tags are stored lower-case, so that is the
 * comparison and the name offered.
 */
export const tagToCreate = (tags: Pick<Tag, 'name'>[], query: string): string | null => {
  const name = query.trim().toLowerCase()
  if (!name || name.length > 40) return null
  return tags.some((t) => t.name.toLowerCase() === name) ? null : name
}
