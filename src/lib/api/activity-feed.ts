import { admin } from '@/lib/supabase/admin'

/**
 * The unified timeline. The union and the ordering live in Postgres
 * (`activity_feed`, migration 019) because the sort has to happen before the
 * limit — stitching five queries together in JavaScript and sorting the result
 * returns the newest rows *of each kind*, not the newest rows.
 */
export type ActivityRow = {
  kind: 'task' | 'event' | 'note' | 'comment' | 'session' | 'knowledge'
  at: string
  actor: string | null
  project_key: string | null
  ref: string
  title: string
  detail: string | null
}

export const activityFeed = async (
  userId: string,
  filters: {
    before?: string
    project?: string
    actor?: string
    kinds?: string[]
    limit: number
  },
): Promise<ActivityRow[]> => {
  const { data, error } = await admin().rpc('activity_feed', {
    p_owner: userId,
    p_before: filters.before ?? null,
    p_limit: filters.limit,
    p_project: filters.project ?? null,
    p_actor: filters.actor ?? null,
    p_kinds: filters.kinds && filters.kinds.length > 0 ? filters.kinds : null,
  })

  if (error) throw new Error(error.message)
  return (data ?? []) as ActivityRow[]
}
