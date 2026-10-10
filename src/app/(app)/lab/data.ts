import { cache } from 'react'
import { listProjects } from '@/lib/data'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import { listStages, listTags } from '@/lib/api/lab-admin'
import { getLabSettings as readLabSettings } from '@/lib/api/lab-settings'
import { HANDOFF_COLUMNS } from '@/lib/api/lab-shape'
import { withAssignees } from '@/lib/api/people'
import { listHumanNotes, listSubjectFiles } from '@/lib/api/subject-extras'
import { getSubjectByNumber, listSubjectNotes, listSubjects, listSubjectTodos } from '@/lib/api/subjects'
import { withLabFields } from '@/lib/api/task-lab-fields'
import { toSubjectQuery, type LabFilters } from '@/components/lab/filters'
import type {
  Handoff, HumanNote, LabAttachment, LabSettings, ProjectRef, Stage, Subject, SubjectNote,
  SubjectSummary, Tag, TaskLabFields, Todo,
} from '@/components/lab/types'

/**
 * Where the Lab's pages read from. Everything the pages need goes through this
 * one object, so a page never names the server library itself, and a test or a
 * later change has one place to look. Each method returns the shape
 * docs/lab.md names, which the client components are typed against.
 *
 * These are the same functions the API routes call, so a page and the API
 * cannot disagree about what a subject is.
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

export const labSource: LabSource = {
  settings: () => readLabSettings(),
  stages: () => listStages(),
  tags: () => listTags(),
  subjects: (userId, filters) => listSubjects(toSubjectQuery(userId, filters)),
  subject: (number) => getSubjectByNumber(number),
  notes: (subject) => listSubjectNotes(subject.id),
  humanNotes: (subject) => listHumanNotes(subject.id),
  attachments: (subject) => listSubjectFiles(subject.id),
  todos: async (subject) => {
    const todos = await withAssignees(await listSubjectTodos(subject.id))
    // The rows are untyped selects; the shape is the contract's `Todo`.
    return todos.map((t): Todo => {
      const row = t as unknown as Record<string, unknown>
      return {
        id: String(row.id),
        ref: String(row.ref),
        number: Number(row.number),
        title: String(row.title),
        status: String(row.status),
        priority: String(row.priority),
        type: String(row.type),
        claimed_by: (row.claimed_by as string | null | undefined) ?? null,
        assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
        handoff: (row.handoff as Handoff | null | undefined) ?? null,
        updated_at: String(row.updated_at),
      }
    })
  },
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

/**
 * A task's Lab-shaped fields for its page: the subject it is a todo of (absent
 * while the Lab is off) and its hand-off. The task loader the page uses does
 * not select these columns; this reads them through the same shaper every API
 * response goes through, so the page and the API agree.
 */
export const loadTaskLabFields = async (taskId: string): Promise<TaskLabFields> => {
  const result = await pool().query(
    `select id, subject_id, ${HANDOFF_COLUMNS} from tasks where id = $1`,
    [taskId],
  )
  const row = (normalizeDatabaseValue(result.rows) as Record<string, unknown>[])[0]
  if (!row) return { handoff: null }
  const [shaped] = await withLabFields([row])
  const fields = shaped as TaskLabFields
  return {
    ...(fields.subject !== undefined ? { subject: fields.subject } : {}),
    handoff: fields.handoff ?? null,
  }
}
