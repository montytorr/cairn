import { cache } from 'react'
import { listProjects } from '@/lib/data'
import type { LabFilters } from '@/components/lab/filters'
import type {
  HumanNote, LabAttachment, LabSettings, ProjectRef, Stage, Subject, SubjectNote,
  SubjectSummary, Tag, Todo,
} from '@/components/lab/types'

/**
 * Where the Lab's pages read from. Everything the pages need goes through this
 * one object, so wiring them to the server library is a change to this file
 * and nothing else: each method returns the shape docs/lab.md names.
 *
 * Until the server library is merged the Lab reads as off, which is the one
 * answer that is true and safe: no page renders, nothing in the app shows it.
 */
export type LabSource = {
  settings: () => Promise<LabSettings>
  stages: () => Promise<Stage[]>
  tags: () => Promise<Tag[]>
  subjects: (userId: string, filters: LabFilters) => Promise<SubjectSummary[]>
  subject: (number: number) => Promise<Subject | null>
  notes: (subject: Pick<Subject, 'id' | 'ref'>) => Promise<SubjectNote[]>
  humanNotes: (subject: Pick<Subject, 'id' | 'ref'>) => Promise<HumanNote[]>
  attachments: (subject: Pick<Subject, 'id' | 'ref'>) => Promise<LabAttachment[]>
  todos: (subject: Pick<Subject, 'id' | 'ref'>) => Promise<Todo[]>
}

const notWired = (what: string) => async (): Promise<never> => {
  throw new Error(`The Lab's ${what} is not wired to the server library yet.`)
}

export const labSource: LabSource = {
  settings: async () => ({ enabled: false, home_project: null, updated_at: null }),
  stages: notWired('stages'),
  tags: notWired('tags'),
  subjects: notWired('subjects'),
  subject: notWired('subject'),
  notes: notWired('log'),
  humanNotes: notWired('notes'),
  attachments: notWired('files'),
  todos: notWired('todos'),
}

/** Deduped within a request: the layout, the page and its metadata all ask. */
export const getLabSettings = cache(() => labSource.settings())

export const isLabEnabled = async () => (await getLabSettings()).enabled

/** Projects a subject can belong to, as the Lab's filters and pickers name them. */
export const listLabProjects = async (userId: string): Promise<ProjectRef[]> => {
  const projects = await listProjects(userId)
  return projects.map((p) => ({ id: p.id, key: p.key, title: p.title }))
}

/**
 * What the settings page's Lab section needs. Stages and tags answer only
 * while the Lab is on, so they are read only then.
 */
export const loadLabAdmin = async (userId: string) => {
  const settings = await getLabSettings()
  const [stages, tags, projects] = await Promise.all([
    settings.enabled ? labSource.stages() : Promise.resolve([] as Stage[]),
    settings.enabled ? labSource.tags() : Promise.resolve([] as Tag[]),
    listLabProjects(userId),
  ])
  return { settings, stages, tags, projects }
}
