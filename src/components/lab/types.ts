/**
 * The Lab's wire shapes, as docs/lab.md sets them. Rows are snake_case, as
 * every Cairn response is. These are the shapes the UI is built against; the
 * server library returns the same ones.
 */

export const STAGE_CATEGORIES = ['planned', 'active', 'completed', 'dropped'] as const
export type StageCategory = (typeof STAGE_CATEGORIES)[number]

export type Stage = {
  id: string
  name: string
  category: StageCategory
  color: string
  position: number
}

export type Tag = { id: string; name: string; color: string; position: number }
export type Person = { id: string; name: string }
export type ProjectRef = { id: string; key: string; title: string }

export type SubjectSummary = {
  id: string
  /** `LAB-12` */
  ref: string
  number: number
  title: string
  stage: Stage
  tags: Tag[]
  project: ProjectRef | null
  owner: Person | null
  conclusion: string | null
  concluded_at: string | null
  /** `done` counts done and cancelled. */
  todos: { open: number; done: number }
  position: number
  actor_type: 'human' | 'agent'
  actor_id: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type Subject = SubjectSummary & { body: string | null }

export type SubjectNote = {
  id: string
  kind: string
  note: string
  actor_type: string
  actor_id: string
  created_at: string
}

export type HumanNote = {
  id: string
  body: string
  author: Person | null
  actor_type: string
  actor_id: string
  created_at: string
  updated_at: string
}

export type LabAttachment = {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  created_at: string
  /** Signed, an hour. */
  preview_url: string
  download_url: string
  /** The stable address markdown embeds. */
  content_url: string
}

export type Handoff = {
  tracker: string
  ref: string
  url: string | null
  status: string | null
  synced_at: string | null
}

export type Todo = {
  id: string
  /** `LT-41`: the task's own ref, in whichever project holds it. */
  ref: string
  number: number
  title: string
  status: string
  priority: string
  type: string
  claimed_by: string | null
  assignee: Person | null
  handoff: Handoff | null
  updated_at: string
}

export type LabSettings = {
  enabled: boolean
  home_project: ProjectRef | null
  updated_at: string | null
}

/** A task's Lab-shaped fields. `subject` is absent while the Lab is off. */
export type TaskLabFields = {
  subject?: { ref: string; title: string } | null
  handoff?: Handoff | null
}

/** Completed and dropped are the two stages that end a subject, and ask for a conclusion. */
export const isConcluding = (category: StageCategory) =>
  category === 'completed' || category === 'dropped'

export const CATEGORY_LABEL: Record<StageCategory, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  dropped: 'Dropped',
}

/** An idea is a subject in a planned stage; the filter says so. */
export const CATEGORY_FILTER_LABEL: Record<StageCategory, string> = {
  planned: 'Ideas',
  active: 'Active',
  completed: 'Completed',
  dropped: 'Dropped',
}

/** `LAB-12`, `lab-12` and `12` are the same subject. */
export const parseSubjectRef = (raw: string): number | null => {
  const match = /^(?:lab-)?(\d{1,9})$/i.exec(raw.trim())
  if (!match) return null
  const n = Number(match[1])
  return n >= 1 ? n : null
}

export const subjectHref = (number: number | string) => `/lab/subjects/${number}`

/** `LT-41` → `/projects/LT/tasks/41`; null for something that is not a task ref. */
export const taskHref = (ref: string): string | null => {
  const at = ref.lastIndexOf('-')
  if (at < 1) return null
  const key = ref.slice(0, at)
  const number = ref.slice(at + 1)
  return /^\d+$/.test(number) ? `/projects/${key}/tasks/${number}` : null
}

/** An admin's colour is trusted as a hex; anything else falls back to a quiet grey. */
export const safeColor = (color: string | null | undefined, fallback = 'var(--fg-subtle)') =>
  color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback

/**
 * Whether a hand-off is open: the tracker owns the status, so Cairn refuses to
 * change it. An ended hand-off (`done` or `cancelled`) is Cairn's again.
 */
export const handoffIsOpen = (handoff: Pick<Handoff, 'status'> | null | undefined) =>
  Boolean(handoff) && handoff?.status !== 'done' && handoff?.status !== 'cancelled'

/** Who may delete: the owner, or an administrator. The server enforces the same rule. */
export const canDeleteSubject = (
  subject: Pick<SubjectSummary, 'owner'>,
  viewer: { userId: string; role: 'admin' | 'member' },
) => viewer.role === 'admin' || (subject.owner !== null && subject.owner.id === viewer.userId)
