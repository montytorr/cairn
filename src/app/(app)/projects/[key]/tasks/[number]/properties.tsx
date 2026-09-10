'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { ResolutionDialog } from '../../resolution-dialog'
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
import { useRenderedClaimStale } from '@/lib/use-mounted'
import type { Task, Project, Relation } from '@/lib/data'

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const Section = ({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <span className="text-fg-subtle text-[11px] font-medium">{title}</span>
    {children}
  </div>
)

/**
 * A property row that opens a native select on click but renders as plain
 * text with an icon — the control chrome would dominate a narrow sidebar,
 * and these are read far more often than they are changed.
 */
const SelectRow = <T extends string>({
  value,
  options,
  labels,
  icon,
  onChange,
  disabled,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  icon: React.ReactNode
  onChange: (v: T) => void
  disabled?: boolean
}) => (
  <div className="hover:bg-surface-hover relative -mx-1.5 flex h-[28px] items-center gap-2 rounded-md px-1.5 transition-colors">
    {icon}
    <span className="text-fg text-[13px]">{labels?.[value] ?? value}</span>
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="absolute inset-0 cursor-pointer opacity-0"
      aria-label={labels?.[value] ?? value}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  </div>
)

export const Properties = ({
  task,
  project,
  relations = [],
}: {
  task: Task
  project: Project
  relations?: Relation[]
}) => {
  const router = useRouter()
  const stale = useRenderedClaimStale(task.heartbeat_at)
  const [pendingClose, setPendingClose] = useState<TaskStatus | null>(null)
  // An optimistic overlay, stamped with the version of the task it was applied
  // to. When the refresh lands `updated_at` moves on and the overlay stops
  // matching, so it retires itself without an effect clearing state.
  const [optimistic, setOptimistic] = useState<{
    at: string
    values: Partial<Pick<Task, 'status' | 'priority' | 'type'>>
  } | null>(null)

  const shown =
    optimistic && optimistic.at === task.updated_at ? { ...task, ...optimistic.values } : task

  const patch = async (body: Record<string, unknown>) => {
    // Applied before the request so the icon moves on click. On a loaded host
    // the round trip is over a second, and waiting for it reads as a dropped
    // click.
    setOptimistic({ at: task.updated_at, values: body as Partial<Task> })
    const res = await fetch(`/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) router.refresh()
    else setOptimistic(null)
    return res.ok
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

  return (
    <aside
      className="border-border flex shrink-0 flex-row flex-wrap gap-x-5 gap-y-3 border-b px-4 py-3 lg:w-[220px] lg:flex-col lg:gap-5 lg:border-b-0 lg:border-l lg:px-4 lg:py-5"
    >
      <Section title="Properties">
        <SelectRow
          value={shown.status}
          options={TASK_STATUSES}
          labels={STATUS_LABEL}
          icon={<StatusIcon status={shown.status} />}
          onChange={onStatus}
        />
        <SelectRow
          value={shown.priority}
          options={TASK_PRIORITIES}
          icon={<PriorityIcon priority={shown.priority} />}
          onChange={(v: TaskPriority) => void patch({ priority: v })}
        />
        <div className="flex h-[28px] items-center gap-2 px-0">
          {task.claimed_by ? (
            <>
              <Avatar name={task.claimed_by} size={16} />
              <span
                className={cn(
                  'text-[13px]',
                  stale ? 'text-fg-subtle' : 'text-fg',
                )}
              >
                {task.claimed_by}
                {stale ? ' · stale' : ''}
              </span>
            </>
          ) : (
            <>
              <span className="border-border size-[16px] rounded-full border border-dashed" />
              <span className="text-fg-subtle text-[13px]">Unassigned</span>
            </>
          )}
        </div>
      </Section>

      <Section title="Type">
        <div className="hover:bg-surface-hover relative -mx-1.5 flex h-[28px] items-center rounded-md px-1.5">
          <TypePill type={shown.type} />
          <select
            value={shown.type}
            onChange={(e) => void patch({ type: e.target.value as TaskType })}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Type"
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </Section>

      {task.labels.length > 0 && (
        <Section title="Labels">
          <div className="flex flex-wrap gap-1.5">
            {task.labels.map((l) => (
              <LabelPill key={l}>{l}</LabelPill>
            ))}
          </div>
        </Section>
      )}

      <DependencyEditor taskRef={`${project.key}-${task.number}`} relations={relations} />

      <div className="hidden lg:block">
      <Section title="Project">
        <span className="text-fg-muted flex items-center gap-1.5 text-[13px]">
          <ProjectIcon size={13} projectKey={project.key} />
          {project.title}
        </span>
      </Section>
      </div>

      {task.external_ref && (
        <Section title="Imported from" className="hidden lg:flex">
          <code className="text-fg-subtle text-[12px]">{task.external_ref}</code>
        </Section>
      )}

      {task.attempt > 1 && (
        <Section title="Attempts" className="hidden lg:flex">
          <span className="text-fg-muted tabular text-[13px]">
            {task.attempt} claims
            <span className="text-fg-subtle"> — may be thrashing</span>
          </span>
        </Section>
      )}

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
