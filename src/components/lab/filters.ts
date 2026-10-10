import { STAGE_CATEGORIES, type StageCategory } from './types'

/**
 * What the Lab's list and board are narrowed by. All of it lives in the URL,
 * so a filtered Lab is a link someone can be sent, and the server renders the
 * same subjects the client hydrates.
 */
export type LabFilters = {
  /** Stage names. */
  stage: string[]
  category: StageCategory[]
  /** Tag names. */
  tag: string[]
  /** `me`, a user id, or empty for everyone. */
  owner: string
  /** Project keys, and `none` for subjects that belong to no project. */
  project: string[]
  q: string
  archived: boolean
}

export const NO_FILTERS: LabFilters = {
  stage: [],
  category: [],
  tag: [],
  owner: '',
  project: [],
  q: '',
  archived: false,
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams

const first = (params: Params, name: string): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined
  const value = params[name]
  return Array.isArray(value) ? value[0] : value
}

const list = (raw: string | undefined) =>
  [...new Set((raw ?? '').split(',').map((v) => v.trim()).filter(Boolean))]

export const parseLabFilters = (params: Params): LabFilters => ({
  stage: list(first(params, 'stage')),
  category: list(first(params, 'category')).filter((c): c is StageCategory =>
    (STAGE_CATEGORIES as readonly string[]).includes(c),
  ),
  tag: list(first(params, 'tag')),
  owner: (first(params, 'owner') ?? '').trim(),
  project: list(first(params, 'project')),
  q: (first(params, 'q') ?? '').trim(),
  archived: first(params, 'archived') === 'include',
})

/** The query the API takes; also what the Lab's own URL carries. */
export const labQueryString = (filters: LabFilters): string => {
  const params = new URLSearchParams()
  if (filters.stage.length) params.set('stage', filters.stage.join(','))
  if (filters.category.length) params.set('category', filters.category.join(','))
  if (filters.tag.length) params.set('tag', filters.tag.join(','))
  if (filters.owner) params.set('owner', filters.owner)
  if (filters.project.length) params.set('project', filters.project.join(','))
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.archived) params.set('archived', 'include')
  return params.toString()
}

export const labUrl = (filters: LabFilters) => {
  const qs = labQueryString(filters)
  return qs ? `/lab?${qs}` : '/lab'
}

export const hasFilters = (filters: LabFilters) => labQueryString(filters) !== ''
