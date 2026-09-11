import { admin } from '@/lib/db/client'

/**
 * Entities, read-only, for the knowledge UI's filters and edit form.
 *
 * Kept separate from the `/api/v1/entities` route rather than shared with it:
 * that route also owns create/patch, and this is the one shape a
 * server-rendered page needs — key, title, and the project keys it groups.
 */
export type EntityRow = {
  key: string
  title: string
  description: string
  projects: string[]
}

export const listEntities = async (userId: string): Promise<EntityRow[]> => {
  const { data, error } = await admin()
    .from('entities')
    .select('key, title, description, project_entities(project:projects(key))')
    .eq('owner_user_id', userId)
    .order('key')
  if (error) throw new Error(error.message)

  return (data ?? []).map((e) => ({
    key: e.key as string,
    title: e.title as string,
    description: (e.description as string) ?? '',
    projects: (
      (e.project_entities ?? []) as unknown as {
        project: { key: string } | { key: string }[] | null
      }[]
    )
      .map((pe) => (Array.isArray(pe.project) ? pe.project[0]?.key : pe.project?.key))
      .filter((k): k is string => Boolean(k))
      .sort(),
  }))
}
