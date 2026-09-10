'use client'

import { InlineInput } from '@/components/ui/control'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'

/**
 * Deleting a project takes every task in it. The confirmation asks for the
 * key by hand rather than offering a button, so it cannot be dismissed by
 * reflex — and the count is shown first so the cost is known before typing.
 */
const DeleteDialog = ({
  projectKey,
  taskCount,
  onClose,
}: {
  projectKey: string
  taskCount: number
  onClose: () => void
}) => {
  const router = useRouter()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const armed = typed.trim().toUpperCase() === projectKey

  const submit = async () => {
    if (!armed) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/v1/projects/${projectKey}?confirm=${encodeURIComponent(projectKey)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(json?.error?.message ?? 'Could not delete the project.')
        return
      }
      // Nothing left to navigate back to, so go home rather than refresh.
      router.push('/')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="border-border bg-surface w-full max-w-[420px] rounded-lg border p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-fg text-[14px] font-medium">Delete {projectKey}?</h2>
        <p className="text-fg-muted mt-2 text-[13px] leading-relaxed">
          This permanently removes {taskCount} {taskCount === 1 ? 'task' : 'tasks'} along with
          their comments, notes and attachments. Any agent that recorded a resolution here loses
          it. This cannot be undone.
        </p>
        <label className="text-fg-subtle mt-4 block text-[11px] font-medium">
          Type {projectKey} to confirm
        </label>
        <InlineInput
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onClose()
          }}
          className="focus:border-danger focus:ring-danger/25 mt-1.5 h-[30px] text-[13px]"
          aria-label={`Type ${projectKey} to confirm deletion`}
        />
        {error && <p className="text-danger mt-2 text-[12px]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg hover:bg-surface-hover h-[28px] rounded-md px-3 text-[13px] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!armed || busy}
            onClick={() => void submit()}
            className="bg-danger h-[28px] rounded-md px-3 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const ProjectMenu = ({
  projectKey,
  title,
  taskCount,
  archived,
}: {
  projectKey: string
  title: string
  taskCount: number
  archived: boolean
}) => {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState(title)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setStatus = async (status: 'active' | 'archived') => {
    setOpen(false)
    const res = await fetch(`/api/v1/projects/${projectKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    // Archiving removes it from the sidebar, so staying on its page would
    // leave the nav showing nothing selected. Go home instead.
    if (res.ok) {
      if (status === 'archived') router.push('/')
      else router.refresh()
    }
  }

  const rename = async () => {
    const next = draft.trim()
    setRenaming(false)
    if (!next || next === title) return
    const res = await fetch(`/api/v1/projects/${projectKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next }),
    })
    if (res.ok) router.refresh()
    else setDraft(title)
  }

  if (renaming) {
    return (
      <InlineInput
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void rename()
          if (e.key === 'Escape') {
            setDraft(title)
            setRenaming(false)
          }
        }}
        aria-label="Project name"
        className="w-[220px] text-[13px]"
      />
    )
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Project actions"
        aria-expanded={open}
        className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-[24px] place-items-center rounded-md transition-colors"
      >
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div className="border-border bg-surface absolute right-0 top-[28px] z-40 w-[180px] overflow-hidden rounded-md border py-1 shadow-xl">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setDraft(title)
              setRenaming(true)
            }}
            className="text-fg-muted hover:bg-surface-hover hover:text-fg block w-full px-3 py-1.5 text-left text-[13px] transition-colors"
          >
            Rename project
          </button>
          <button
            type="button"
            onClick={() => void setStatus(archived ? 'active' : 'archived')}
            className="text-fg-muted hover:bg-surface-hover hover:text-fg block w-full px-3 py-1.5 text-left text-[13px] transition-colors"
          >
            {archived ? 'Restore from archive' : 'Archive project'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setConfirming(true)
            }}
            className="text-danger hover:bg-danger-subtle block w-full px-3 py-1.5 text-left text-[13px] transition-colors"
          >
            Delete project…
          </button>
        </div>
      )}
      {confirming && (
        <DeleteDialog
          projectKey={projectKey}
          taskCount={taskCount}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
