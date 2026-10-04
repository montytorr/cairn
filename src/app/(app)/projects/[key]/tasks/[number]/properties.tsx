'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Avatar, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import { InlineInput } from '@/components/ui/control'
import { ResolutionDialog } from '../../resolution-dialog'
import { LabelEditor } from '../../label-editor'
import { AlsoIn } from './also-in'
import { DependencyEditor } from './dependency-editor'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  isTerminal,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/schemas/task'
import { cn } from '@/lib/utils'
import { RelativeTime } from '@/components/relative-time'
import { dueDateDisplay, fullDateTime, todayDate } from '@/lib/dates'
import { useMounted, useRenderedClaimStale } from '@/lib/use-mounted'
import type { Task, Project, Relation } from '@/lib/data'
import { useMutate } from '@/lib/api/use-mutate'
import { ROW, ROW_LABEL } from './styles'

/**
 * `claude-code · Cal` on Cal's own task says Cal twice in a narrow column.
 * The agent alone is enough when its human is the assignee; anyone else's
 * agent keeps the name, because then it is the point.
 */
const agentOf = (label: string, assignee: string | undefined) =>
  assignee && label.endsWith(` · ${assignee}`) ? label.slice(0, -` · ${assignee}`.length) : label

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/**
 * An editable value: the row lights as a list row does — a fill and the trail
 * marker — and a chevron surfaces to say it opens. Keyboard focus on the
 * invisible select lights it the same way, since the select itself cannot show
 * a ring.
 *
 * `overflow-hidden` is the backstop: a value that refuses to shrink (a type
 * pill at its widest word) clips inside its own row instead of pushing the
 * pane into a horizontal scrollbar.
 */
const EDITABLE =
  'row-hover group/edit relative -mx-1.5 flex h-[1.75rem] items-center gap-2 overflow-hidden rounded-md px-1.5 ' +
  'has-[:focus-visible]:bg-surface-hover has-[:focus-visible]:shadow-[inset_2px_0_0_var(--accent)]'

const Affordance = () => (
  <ChevronsUpDown
    size={11}
    aria-hidden
    className="text-fg-subtle ml-auto shrink-0 opacity-0 transition-opacity duration-[var(--dur-1)] ease-[var(--ease-out)] group-hover/edit:opacity-100 group-has-[:focus-visible]/edit:opacity-100"
  />
)

/**
 * The label-and-value shell every click-to-edit row shares. `select` renders
 * last so its absolute overlay sits above the label too — a click anywhere on
 * the row opens it, not just the value.
 */
const EditableRow = ({
  label,
  title,
  select,
  children,
}: {
  label: string
  title?: string
  select: React.ReactNode
  children: React.ReactNode
}) => (
  <div className={EDITABLE}>
    <span className={ROW_LABEL}>{label}</span>
    <span className="flex min-w-0 flex-1 items-center gap-1.5" title={title}>
      {children}
    </span>
    <Affordance />
    {select}
  </div>
)

/**
 * A property row that opens a native select on click but renders as plain
 * text with an icon — the control chrome would dominate a narrow sidebar,
 * and these are read far more often than they are changed.
 */
const SelectRow = <T extends string>({
  label,
  value,
  options,
  labels,
  icon,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  icon: React.ReactNode
  onChange: (v: T) => void
  disabled?: boolean
}) => (
  <EditableRow
    label={label}
    title={labels?.[value] ?? value}
    select={
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label={labels?.[value] ?? value}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    }
  >
    {icon}
    <span className="text-fg min-w-0 truncate text-[0.8125rem]">{labels?.[value] ?? value}</span>
  </EditableRow>
)

/**
 * A ref, editable in place — the same click-to-edit shape as the title.
 * Failure is left on the toast `onSave` already raises, but editing stays
 * open rather than closing on a rejected ref: a mistyped one fails a loop
 * check on the server, and the caller needs the field there to try again.
 */
const ParentEditor = ({
  parent,
  onSave,
}: {
  parent: { ref: string; title: string } | null
  onSave: (ref: string | null) => Promise<boolean>
}) => {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    setValue(parent?.ref ?? '')
    setEditing(true)
  }

  const save = async () => {
    const next = value.trim().toUpperCase()
    if (next === (parent?.ref ?? '')) {
      setEditing(false)
      return
    }
    setSaving(true)
    const ok = await onSave(next || null)
    setSaving(false)
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <InlineInput
        autoFocus
        value={value}
        disabled={saving}
        placeholder="CAI-42 — empty clears it"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-[1.75rem] min-w-0 flex-1 text-[0.75rem]"
      />
    )
  }

  return (
    <div className="group/row flex min-w-0 flex-1 items-center gap-2">
      {parent ? (
        <Link
          href={`/projects/${parent.ref.slice(0, parent.ref.lastIndexOf('-'))}/tasks/${parent.ref.slice(parent.ref.lastIndexOf('-') + 1)}`}
          className="text-fg-muted hover:text-fg min-w-0 flex-1 truncate text-[0.8125rem] transition-colors"
          title={parent.title}
        >
          {parent.ref}
        </Link>
      ) : (
        <span className="text-fg-subtle min-w-0 flex-1 truncate text-[0.8125rem]">None</span>
      )}
      <button
        type="button"
        onClick={startEdit}
        className="text-fg-subtle hover:text-fg hover:bg-surface-hover shrink-0 rounded px-1.5 py-px text-[0.6875rem] opacity-0 transition-[opacity,color,background-color] duration-[var(--dur-1)] group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        Edit
      </button>
    </div>
  )
}

/**
 * The due date, shown as a plain row rather than a native `<input type="date">`
 * sitting in the open — WebKit fills an empty one with today's date in grey,
 * which reads as a real value, and the control's own intrinsic width is wider
 * than this column regardless. The input still exists, positioned exactly
 * over the row so the OS picker anchors where the row is, but invisible and
 * unclickable — the button in front of it is what the reader actually sees
 * and clicks.
 */
const DueDateRow = ({
  label,
  value,
  overdue,
  onPick,
  onClear,
}: {
  label: string
  value: string | null
  overdue: boolean
  onPick: (next: string | null) => void
  onClear: () => void
}) => {
  const inputRef = useRef<HTMLInputElement>(null)

  const open = () => {
    const el = inputRef.current
    if (!el) return
    const withPicker = el as HTMLInputElement & { showPicker?: () => void }
    if (typeof withPicker.showPicker === 'function') {
      try {
        withPicker.showPicker()
        return
      } catch {
        // Falls through to the focus/click fallback below.
      }
    }
    el.focus()
    el.click()
  }

  return (
    <div className={cn(ROW, 'relative')}>
      <span className={ROW_LABEL}>Due date</span>
      <button
        type="button"
        onClick={open}
        className={cn(
          'flex h-[1.5rem] min-w-0 flex-1 items-center rounded px-1 text-left text-[0.8125rem] transition-colors',
          overdue ? 'text-danger' : value ? 'text-fg' : 'text-fg-subtle',
        )}
      >
        <span className="min-w-0 truncate" title={value ? fullDateTime(value) : undefined}>
          {label}
        </span>
      </button>
      {value && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear due date"
          className="text-fg-subtle hover:text-fg shrink-0 px-0.5 text-[0.8125rem] leading-none"
        >
          ×
        </button>
      )}
      <input
        ref={inputRef}
        type="date"
        value={value ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        aria-label="Due date"
        tabIndex={-1}
        className="pointer-events-none absolute inset-0 opacity-0"
      />
    </div>
  )
}

type OptimisticValues = Partial<
  Pick<Task, 'status' | 'priority' | 'type' | 'assignee_user_id' | 'assignee' | 'due_date' | 'labels'>
>

export const Properties = ({
  task,
  project,
  relations = [],
  alsoProjects = [],
  projects = [],
  parent = null,
}: {
  task: Task
  project: Project
  relations?: Relation[]
  alsoProjects?: string[]
  projects?: { key: string; title: string }[]
  parent?: { ref: string; title: string } | null
}) => {
  const router = useRouter()
  const request = useMutate()
  const { people } = usePeople()
  const mounted = useMounted()
  const stale = useRenderedClaimStale(task.heartbeat_at)
  const [pendingClose, setPendingClose] = useState<TaskStatus | null>(null)
  const [moving, setMoving] = useState(false)
  const [knownLabels, setKnownLabels] = useState<string[]>([])

  // Fetched once. Offering labels already in use is what keeps this from
  // growing a second spelling of a label the list view already offers.
  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/v1/labels')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      setKnownLabels(((json?.data ?? []) as { label: string }[]).map((l) => l.label))
    }
    void load()
  }, [])

  // An optimistic overlay, stamped with the version of the task it was applied
  // to. When the refresh lands `updated_at` moves on and the overlay stops
  // matching, so it retires itself without an effect clearing state.
  const [optimistic, setOptimistic] = useState<{ at: string; values: OptimisticValues } | null>(null)

  const shown =
    optimistic && optimistic.at === task.updated_at ? { ...task, ...optimistic.values } : task

  const patch = async (
    body: Record<string, unknown>,
    optimisticValues: OptimisticValues = body as OptimisticValues,
  ) => {
    // Applied before the request so the icon moves on click. On a loaded host
    // the round trip is over a second, and waiting for it reads as a dropped
    // click.
    setOptimistic({ at: task.updated_at, values: optimisticValues })
    const result = await request(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body })
    // Status asks for a resolution before it gets here, but priority and type
    // had no guard at all: any refusal rolled the dropdown back with nothing
    // said, which is indistinguishable from a dropped click.
    if (!result.ok) {
      setOptimistic(null)
      return false
    }
    router.refresh()
    return true
  }

  const onAssignee = (userId: string) => {
    const person = people.find((p) => p.id === userId) ?? null
    void patch({ assignee: userId }, { assignee_user_id: userId, assignee: person })
  }

  /**
   * Moving is its own request rather than going through `patch` above:
   * per-project numbering means the ref changes underneath this page, so a
   * success here has to navigate rather than just refresh in place.
   */
  const onProject = async (nextKey: string) => {
    if (nextKey === project.key || moving) return
    setMoving(true)
    const result = await request<{ moved?: { ref: string; from: string } | null }>(
      `/api/v1/tasks/${task.id}`,
      { method: 'PATCH', body: { project: nextKey } },
    )
    setMoving(false)
    if (!result.ok) return
    const moved = result.data?.moved
    if (!moved) {
      router.refresh()
      return
    }
    const idx = moved.ref.lastIndexOf('-')
    router.replace(`/projects/${moved.ref.slice(0, idx)}/tasks/${moved.ref.slice(idx + 1)}`)
  }

  const onParent = async (ref: string | null) => {
    const result = await request(`/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      body: { parentRef: ref },
    })
    if (!result.ok) return false
    router.refresh()
    return true
  }

  const onStatus = (next: TaskStatus) => {
    // Closing needs a resolution, so ask rather than fire a PATCH the API
    // will refuse — otherwise the change appears to silently fail.
    if (isTerminal(next) && !task.resolution) {
      setPendingClose(next)
      return
    }
    void patch({ status: next })
  }

  const due = dueDateDisplay(shown.due_date, isTerminal(shown.status), todayDate())
  // Gated behind `mounted` for the same reason `useRenderedClaimStale` is:
  // "today" is read off the reader's clock, which the server cannot know, so
  // the first render — server and client alike — treats nothing as overdue.
  const overdue = mounted && due.overdue

  const assigneeTitle = shown.assignee
    ? shown.assignee.email && shown.assignee.email !== shown.assignee.name
      ? `${shown.assignee.name} · ${shown.assignee.email}`
      : shown.assignee.name
    : undefined

  return (
    <aside className="flex w-full shrink-0 flex-col overflow-x-hidden px-4 py-5">
      <div className="flex flex-col gap-0.5">
        <SelectRow
          label="Status"
          value={shown.status}
          options={TASK_STATUSES}
          labels={STATUS_LABEL}
          icon={<StatusIcon status={shown.status} />}
          onChange={onStatus}
        />
        <SelectRow
          label="Priority"
          value={shown.priority}
          options={TASK_PRIORITIES}
          icon={<PriorityIcon priority={shown.priority} />}
          onChange={(v: TaskPriority) => void patch({ priority: v })}
        />
        <EditableRow
          label="Type"
          select={
            <select
              value={shown.type}
              onChange={(e) => void patch({ type: e.target.value as TaskType })}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Type"
            >
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          }
        >
          <TypePill type={shown.type} />
        </EditableRow>

        {/* The human who owns the work, editable — distinct from who is
            currently holding it below. Every task has one; there is no empty
            state to draw. */}
        <EditableRow
          label="Assignee"
          title={assigneeTitle}
          select={
            <select
              value={shown.assignee_user_id}
              onChange={(e) => onAssignee(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Assignee"
            >
              {/* The current assignee may have gone inactive since —
                  `listPeople` only offers active users, so their own option
                  is added back in or the select would silently show someone
                  else. */}
              {shown.assignee && !people.some((p) => p.id === shown.assignee_user_id) && (
                <option value={shown.assignee_user_id}>{shown.assignee.name} (inactive)</option>
              )}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          }
        >
          <Avatar name={shown.assignee?.name ?? 'Unknown'} size={16} />
          <span className="text-fg min-w-0 truncate text-[0.8125rem]">
            {shown.assignee?.name ?? 'Unknown'}
            {shown.assignee && !shown.assignee.active ? (
              <span className="text-fg-subtle"> (inactive)</span>
            ) : null}
          </span>
        </EditableRow>

        {/* The agent actually holding it right now, which may be nobody even
            though the task is always assigned to someone. */}
        <div className={ROW}>
          <span className={ROW_LABEL}>Held by</span>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {task.claimed_by ? (
              <>
                <Avatar name={task.claimed_by} size={16} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[0.8125rem]',
                    stale ? 'text-fg-subtle' : 'text-fg',
                  )}
                  title={stale ? `${task.claimed_by} · stale, no recent heartbeat` : task.claimed_by}
                >
                  {agentOf(task.claimed_by, shown.assignee?.name)}
                </span>
                {stale && (
                  <span
                    aria-hidden
                    className="size-[0.375rem] shrink-0 rounded-full"
                    style={{ backgroundColor: 'var(--priority-high)' }}
                  />
                )}
              </>
            ) : (
              <>
                <span className="border-border-strong size-[1rem] shrink-0 rounded-full border border-dashed" />
                <span className="text-fg-subtle min-w-0 flex-1 truncate text-[0.8125rem]">Unclaimed</span>
              </>
            )}
          </div>
        </div>

        <div className={ROW}>
          <span className={ROW_LABEL}>Labels</span>
          <div className="min-w-0 flex-1">
            <LabelEditor
              taskRef={`${project.key}-${task.number}`}
              labels={shown.labels}
              known={knownLabels}
              alwaysVisible
              onChange={(next) => void patch({ labels: next }, { labels: next })}
            />
          </div>
        </div>

        <DueDateRow
          label={due.label}
          value={shown.due_date}
          overdue={overdue}
          onPick={(next) => void patch({ dueDate: next }, { due_date: next })}
          onClear={() => void patch({ dueDate: null }, { due_date: null })}
        />
      </div>

      <div className="border-border mt-4 flex flex-col gap-0.5 border-t pt-4">
        {projects.length > 0 ? (
          <SelectRow
            label="Project"
            value={project.key}
            options={projects.map((p) => p.key)}
            labels={Object.fromEntries(projects.map((p) => [p.key, p.title]))}
            icon={<ProjectIcon size={13} projectKey={project.key} />}
            disabled={moving}
            onChange={onProject}
          />
        ) : (
          <div className={ROW}>
            <span className={ROW_LABEL}>Project</span>
            <span className="text-fg-muted flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem]">
              <ProjectIcon size={13} projectKey={project.key} />
              <span className="min-w-0 truncate">{project.title}</span>
            </span>
          </div>
        )}

        {projects.length > 0 && (
          <AlsoIn
            taskRef={`${project.key}-${task.number}`}
            homeKey={project.key}
            alsoProjects={alsoProjects}
            projects={projects}
          />
        )}

        <div className={ROW}>
          <span className={ROW_LABEL}>Parent</span>
          <ParentEditor parent={parent} onSave={onParent} />
        </div>

        <DependencyEditor taskRef={`${project.key}-${task.number}`} relations={relations} />
      </div>

      <div className="border-border mt-4 flex flex-col gap-1 border-t pt-3">
        <p
          className="text-fg-subtle truncate text-[0.75rem]"
          title={`${task.actor_id} · ${fullDateTime(task.created_at)}`}
        >
          Created <RelativeTime iso={task.created_at} /> by {agentOf(task.actor_id, shown.assignee?.name)}
        </p>
        <p className="text-fg-subtle text-[0.75rem]">
          Updated <RelativeTime iso={task.updated_at} />
        </p>
        {task.resolved_at && (
          <p
            className="text-fg-subtle truncate text-[0.75rem]"
            title={[task.resolved_by, fullDateTime(task.resolved_at)].filter(Boolean).join(' · ')}
          >
            Resolved <RelativeTime iso={task.resolved_at} />
            {task.resolved_by ? ` by ${task.resolved_by}` : ''}
          </p>
        )}
        {task.external_ref && (
          <p className="text-fg-subtle truncate text-[0.75rem]" title={task.external_ref}>
            From{' '}
            {task.external_url && /^https?:\/\//i.test(task.external_url) ? (
              <a href={task.external_url} target="_blank" rel="noopener noreferrer" className="font-mono underline">
                {task.external_ref}
              </a>
            ) : (
              <span className="font-mono">{task.external_ref}</span>
            )}
          </p>
        )}
        {task.attempt > 1 && (
          <p className="text-fg-subtle text-[0.75rem]">
            Attempts {task.attempt} <span>— may be thrashing</span>
          </p>
        )}
      </div>

      {pendingClose && (
        <ResolutionDialog
          taskTitle={task.title}
          status={pendingClose}
          suggestion={task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind, duplicateOf) => {
            const ok = await patch({
              status: pendingClose,
              resolution,
              resolutionKind: kind,
              ...(duplicateOf ? { duplicateOf } : {}),
            })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </aside>
  )
}
