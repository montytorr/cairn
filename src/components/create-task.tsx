'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import {
  TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES,
  type TaskPriority, type TaskStatus, type TaskType,
} from '@/schemas/task'
import { cn } from '@/lib/utils'

/**
 * Task creation.
 *
 * Everything except the title has a default, and the dialog opens with only
 * the title focused. Friction on creation is how a tracker ends up empty, so
 * the fast path is: press c, type, press enter.
 */
export const CreateTask = ({
  projects,
  defaultProject,
  open,
  onClose,
}: {
  projects: { key: string; title: string }[]
  defaultProject?: string
  open: boolean
  onClose: () => void
}) => {
  const router = useRouter()
  const titleRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [project, setProject] = useState(defaultProject ?? projects[0]?.key ?? '')
  const [type, setType] = useState<TaskType>('feature')
  const [status, setStatus] = useState<TaskStatus>('backlog')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [similar, setSimilar] = useState<{ ref: string; title: string; status: string }[]>([])
  const [labels, setLabels] = useState('')
  // Existing labels, offered as suggestions. Offering what is already in use
  // is the only thing that stops a fourth spelling of "database" appearing.
  const [known, setKnown] = useState<string[]>([])

  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/v1/labels')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      setKnown(((json?.data ?? []) as { label: string }[]).map((l) => l.label))
    }
    void load()
  }, [])

  // Focus only. State is NOT reset here: the parent remounts this component
  // on each open (via key), so it always starts fresh without an effect
  // writing state synchronously.
  useEffect(() => {
    if (open) titleRef.current?.focus()
  }, [open])

  // The same duplicate check the CLI does on `cairn add`, surfaced as you
  // type. Finding the existing task is more useful than filing a second one.
  // Derived rather than cleared in an effect.
  const showSimilar = title.trim().length >= 8
  const visibleSimilar = showSimilar ? similar : []

  useEffect(() => {
    if (!open || !showSimilar) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(title)}&limit=3`, {
          signal: controller.signal,
        })
        const payload = await res.json()
        setSimilar(payload.success ? payload.data.results : [])
      } catch {
        // aborted; keep what is on screen
      }
    }, 400)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [title, open, showSimilar])

  const submit = async () => {
    if (!title.trim() || !project || pending) return
    setPending(true)
    setError(null)

    const res = await fetch(`/api/v1/projects/${project}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        description: body.trim() || undefined,
        type, status, priority,
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    })
    const payload = await res.json().catch(() => null)
    setPending(false)

    if (!payload?.success) {
      setError(payload?.error ?? 'Could not create the task.')
      return
    }
    onClose()
    router.push(`/projects/${project}/tasks/${payload.data.number}`)
    router.refresh()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void submit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!open) return null

  const chip =
    'relative flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2 text-[12px] ' +
    'text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="bg-surface border-border pop w-full max-w-[560px] overflow-hidden rounded-lg border shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-3.5">
          <ProjectIcon size={12} projectKey={project || undefined} />
          <span className="text-fg-subtle text-[11px]">New task in {project || '—'}</span>
        </div>

        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Task title"
          className="placeholder:text-fg-subtle w-full bg-transparent px-4 pt-2 pb-1 text-[16px] outline-none"
        />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description — markdown, optional"
          rows={3}
          className="placeholder:text-fg-subtle w-full resize-none bg-transparent px-4 pb-3 text-[13px] leading-relaxed outline-none"
        />

        {visibleSimilar.length > 0 && (
          <div className="border-border mx-4 mb-3 rounded-md border px-2.5 py-2">
            <p className="text-fg-subtle mb-1.5 text-[11px]">Similar work already exists</p>
            <ul className="flex flex-col gap-1">
              {visibleSimilar.map((s) => (
                <li key={s.ref} className="flex items-center gap-2 text-[12px]">
                  <StatusIcon status={s.status as TaskStatus} size={12} />
                  <code className="text-fg-subtle text-[11px]">{s.ref}</code>
                  <span className="text-fg-muted min-w-0 truncate">{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-border flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5">
          <label className={chip}>
            <ProjectIcon size={12} projectKey={project || undefined} />
            {project}
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Project"
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>{p.title}</option>
              ))}
            </select>
          </label>

          <label className={cn(chip, 'pr-1')}>
            <TypePill type={type} />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TaskType)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Type"
            >
              {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className={chip}>
            <StatusIcon status={status} size={13} />
            {status}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Status"
            >
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className={chip}>
            <PriorityIcon priority={priority} size={13} />
            {priority}
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Priority"
            >
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          <label className="relative">
            <input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              list="cairn-known-labels"
              placeholder="labels…"
              aria-label="Labels, comma separated"
              className="border-border bg-bg text-fg placeholder:text-fg-subtle focus:border-accent h-[26px] w-[130px] rounded-md border px-2 text-[12px] outline-none"
            />
            <datalist id="cairn-known-labels">
              {known.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || !project || pending}
            className="bg-accent text-accent-fg ml-auto h-[26px] rounded-md px-3 text-[12px] font-medium transition-opacity disabled:opacity-40"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>

        {error && <p className="text-danger px-4 pb-3 text-[12px]">{error}</p>}
      </div>
    </div>
  )
}
