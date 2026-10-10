import { viewCookieName } from '@/lib/project-view'
import { STAGE_CATEGORIES, type StageCategory } from './types'

/**
 * The list-or-board choice, remembered per browser as a project's is. Here and
 * not in the client view: a server page reads it, and a constant imported from
 * a client module arrives there as a reference, not as the string.
 */
export const LAB_VIEW_COOKIE = viewCookieName('lab')

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the server library's `listSubjects` takes. */
export type SubjectQuery = {
  stage?: string
  category?: string
  tag?: string
  project?: string
  ownerId?: string
  q?: string
  archived: 'exclude' | 'include'
}

/**
 * The page's filters as the library takes them. `me` is the viewer; an owner
 * that is neither `me` nor a user id is dropped rather than sent, since the
 * query casts it and a hand-typed address must not become a 500.
 */
export const toSubjectQuery = (userId: string, filters: LabFilters): SubjectQuery => {
  const ownerId = filters.owner === 'me' ? userId : UUID.test(filters.owner) ? filters.owner : undefined
  return {
    ...(filters.stage.length ? { stage: filters.stage.join(',') } : {}),
    ...(filters.category.length ? { category: filters.category.join(',') } : {}),
    ...(filters.tag.length ? { tag: filters.tag.join(',') } : {}),
    ...(filters.project.length ? { project: filters.project.join(',') } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    archived: filters.archived ? 'include' : 'exclude',
  }
}
