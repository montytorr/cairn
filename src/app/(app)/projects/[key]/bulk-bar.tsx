'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { StatusIcon, PriorityIcon } from '@/components/icons'
import { ResolutionDialog } from './resolution-dialog'
import { mutate } from '@/lib/api/mutate'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  isTerminal,
  type ResolutionKind,
  type TaskPriority,
  type TaskStatus,
} from '@/schemas/task'

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/**
 * Sequential on purpose. Firing 40 PATCHes at once on a host that already runs
 * at load 20 is how a bulk edit turns into a timeout; the bar reports progress
 * instead, which is honest and no slower in practice.
 */
const applyAll = async (
  ids: string[],
  patch: Record<string, unknown>,
  onProgress: (done: number) => void,
) => {
  const failures: string[] = []
  let reason: string | null = null
  let done = 0
  for (const id of ids) {
    const result = await mutate(`/api/v1/tasks/${id}`, { method: 'PATCH', body: patch })
    if (!result.ok) {
      failures.push(id)
      // One reason is enough: a bulk edit fails the same way forty times.
      // Before this a thrown fetch also escaped the loop entirely, freezing
      // the counter mid-run with nothing said.
      reason ??= result.error
    }
    onProgress(++done)
  }
  return { failures, reason }
}

const Action = <T extends string>({
  label,
  options,
  labels,
  icon,
  onPick,
}: {
  label: string
  options: readonly T[]
  labels?: Record<string, string>
  icon: (v: T) => React.ReactNode
  onPick: (v: T) => void
}) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Outside-click and Escape, like every other menu here. The previous
  // onBlur-with-a-timeout raced the menu's own click handler.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`h-[26px] rounded-md px-2.5 text-[12px] transition-colors ${
          open ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
        }`}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-surface absolute bottom-[32px] left-0 z-50 w-[168px] overflow-hidden rounded-md border py-1 shadow-xl"
        >
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(o)
              }}
              className="text-fg-muted hover:bg-surface-hover hover:text-fg flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors"
            >
              {icon(o)}
              {labels?.[o] ?? o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const BulkBar = ({
  ids,
  onClear,
}: {
  ids: string[]
  onClear: () => void
}) => {
  const router = useRouter()
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState<TaskStatus | null>(null)

  const run = async (patch: Record<string, unknown>) => {
    setError(null)
    setProgress(0)
    const { failures, reason } = await applyAll(ids, patch, setProgress)
    setProgress(null)
    if (failures.length > 0) {
      setError(`${failures.length} of ${ids.length} could not be changed — ${reason}`)
      return false
    }
    onClear()
    router.refresh()
    return true
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
        {/* No `overflow-x-auto` here, ever. Setting one overflow axis to
            `auto` forces the other from `visible` to `auto`, so the bar became
            a scroll container in both directions and clipped its own Status
            and Priority menus — which open *above* it — out of existence.
            The content is ~300px; it wraps rather than scrolls. */}
        <div className="border-border bg-surface pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-1 rounded-lg border px-2 py-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <span className="text-fg tabular px-1.5 text-[12px] font-medium">
            {progress === null
              ? `${ids.length} selected`
              : `${progress} / ${ids.length}…`}
          </span>
          <span className="bg-border mx-1 h-[16px] w-px" aria-hidden />

          <Action
            label="Status"
            options={TASK_STATUSES}
            labels={STATUS_LABEL}
            icon={(s: TaskStatus) => <StatusIcon status={s} size={13} />}
            onPick={(s) => {
              // Closing still requires saying how — one resolution, applied to
              // the whole selection, rather than a waived rule.
              if (isTerminal(s)) setClosing(s)
              else void run({ status: s })
            }}
          />
          <Action
            label="Priority"
            options={TASK_PRIORITIES}
            icon={(p: TaskPriority) => <PriorityIcon priority={p} />}
            onPick={(p) => void run({ priority: p })}
          />

          {error && <span className="text-danger px-2 text-[12px]">{error}</span>}

          <span className="bg-border mx-1 h-[16px] w-px" aria-hidden />
          <button
            type="button"
            onClick={onClear}
            className="text-fg-subtle hover:text-fg h-[26px] rounded-md px-2 text-[12px] transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {closing && (
        <ResolutionDialog
          taskTitle={`${ids.length} tasks`}
          status={closing}
          suggestion={null}
          onCancel={() => setClosing(null)}
          allowDuplicate={false}
          onConfirm={async (resolution: string, kind: ResolutionKind) => {
            const ok = await run({ status: closing, resolution, resolutionKind: kind })
            if (ok) setClosing(null)
            return ok
          }}
        />
      )}
    </>
  )
}
