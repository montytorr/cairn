'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, isTerminal, type TaskStatus } from '@/schemas/task'
import { ResolutionDialog } from '../../resolution-dialog'
import { Select } from '@/components/ui/control'
import type { Task } from '@/lib/data'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2 py-1">
    <span className="text-fg-subtle text-[11px]">{label}</span>
    {children}
  </div>
)

export const TaskMeta = ({ task }: { task: Task }) => {
  const router = useRouter()
  const [pendingClose, setPendingClose] = useState<TaskStatus | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true)
    const res = await fetch(`/api/v1/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (res.ok) router.refresh()
    return res.ok
  }

  const onStatus = (next: TaskStatus) => {
    // Same rule as the board: closing needs a resolution, so ask rather than
    // let the API reject the change.
    if (isTerminal(next) && !task.resolution) {
      setPendingClose(next)
      return
    }
    void patch({ status: next })
  }

  return (
    <div className="flex flex-col">
      <Row label="Status">
        <Select
          size="sm"
          value={task.status}
          onChange={(e) => onStatus(e.target.value as TaskStatus)}
          disabled={saving}
          aria-label="Status"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      </Row>

      <Row label="Type">
        <Select
          size="sm"
          value={task.type}
          onChange={(e) => void patch({ type: e.target.value })}
          disabled={saving}
          aria-label="Type"
        >
          {TASK_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </Row>

      <Row label="Priority">
        <Select
          size="sm"
          value={task.priority}
          onChange={(e) => void patch({ priority: e.target.value })}
          disabled={saving}
          aria-label="Priority"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      </Row>

      <Row label="Labels">
        <span className="text-fg-muted flex-1 text-xs">
          {task.labels.length ? task.labels.join(', ') : '—'}
        </span>
      </Row>

      <Row label="Created">
        <span className="text-fg-muted flex-1 text-xs">
          {task.created_at.slice(0, 10)} by{' '}
          <span className={task.actor_type === 'agent' ? 'text-accent' : ''}>
            {task.actor_type === 'agent' ? task.actor_id : 'you'}
          </span>
        </span>
      </Row>

      {pendingClose && (
        <ResolutionDialog
          taskTitle={task.title}
          status={pendingClose}
          suggestion={task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind) => {
            const ok = await patch({ status: pendingClose, resolution, resolutionKind: kind })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </div>
  )
}
