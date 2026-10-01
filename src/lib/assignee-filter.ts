/**
 * Whose tasks a list or board shows, as the `assignee` query parameter.
 *
 * The default is the viewer's own: an instance shared by a team opened on
 * everybody's work, and "what is mine" took a dedicated tab that ignored
 * status, so "my tasks in progress" could not be asked at all (CAIRN-339).
 *
 *   (absent)       just me — the default, so a plain link stays plain
 *   assignee=all   everyone
 *   assignee=me    me, whoever opens the link
 *   assignee=a,b   those people (ids; `me` may be one of them)
 *
 * An empty selection means everyone, as every other board filter does.
 */
export const ASSIGNEE_PARAM = 'assignee'
export const EVERYONE = 'all'
export const ME = 'me'

export const parseAssignees = (raw: string | null | undefined, me: string): string[] => {
  if (raw === null || raw === undefined) return me ? [me] : []
  if (raw === EVERYONE) return []
  const ids = raw
    .split(',')
    .map((v) => (v === ME ? me : v))
    .filter(Boolean)
  return [...new Set(ids)]
}

/** The parameter's value for a selection, or null when it is the default. */
export const serializeAssignees = (selected: string[], me: string): string | null => {
  if (selected.length === 0) return me ? EVERYONE : null
  if (me && selected.length === 1 && selected[0] === me) return null
  return selected.map((id) => (id === me ? ME : id)).join(',')
}

/** `search` with its assignee parameter set for `selected`, everything else kept. */
export const withAssignees = (search: string, selected: string[], me: string): string => {
  const params = new URLSearchParams(search)
  const value = serializeAssignees(selected, me)
  if (value === null) params.delete(ASSIGNEE_PARAM)
  else params.set(ASSIGNEE_PARAM, value)
  return params.toString()
}

export const matchesAssignees = (task: { assignee_user_id: string }, selected: string[]): boolean =>
  selected.length === 0 || selected.includes(task.assignee_user_id)
