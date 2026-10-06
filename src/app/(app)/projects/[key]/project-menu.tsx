'use client'

import { InlineInput } from '@/components/ui/control'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { ChangeKeyDialog, type RetiredKeyOwner } from '@/components/change-key-dialog'

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
      // `json.error.message` was always undefined — the envelope carries
      // `error` as a plain string — so this only ever showed its fallback.
      const result = await mutate(
        `/api/v1/projects/${projectKey}?confirm=${encodeURIComponent(projectKey)}`,
        { method: 'DELETE' },
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      // Both calls, and in this order. `push` alone leaves the layout's
      // cached RSC payload in place — and the sidebar's project list is
      // rendered by that layout, so the deleted project stayed on screen
      // until a manual reload. `refresh` is what re-runs listProjects.
      router.replace('/')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="scrim fixed inset-0 z-50 grid place-items-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="border-border bg-surface enter-sheet relative w-full max-w-[26.25rem] rounded-xl border p-5 raised-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-fg text-ui font-medium">Delete {projectKey}?</h2>
        <p className="text-fg-muted mt-2 text-ui leading-relaxed">
          This permanently removes {taskCount} {taskCount === 1 ? 'task' : 'tasks'} along with
          their comments, notes and attachments. Any agent that recorded a resolution here loses
          it. This cannot be undone.
        </p>
        <label className="text-fg-subtle mt-4 block text-meta font-medium">
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
          className="focus:border-danger focus:ring-danger/25 mt-1.5 h-[1.875rem] text-ui"
          aria-label={`Type ${projectKey} to confirm deletion`}
        />
        {error && <p className="text-danger mt-2 text-meta">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg hover:bg-surface-hover h-[1.75rem] rounded-md px-3 text-ui transition-colors duration-[var(--dur-1)] ease-[var(--ease)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!armed || busy}
            onClick={() => void submit()}
            className="bg-danger h-[1.75rem] rounded-md px-3 text-ui font-medium text-white transition-[opacity,filter] duration-[var(--dur-1)] ease-[var(--ease)] hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const ProjectMenu = ({
  projectId,
  projectKey,
  title,
  taskCount,
  archived,
  liveKeys,
  retired,
}: {
  projectId: string
  projectKey: string
  title: string
  taskCount: number
  archived: boolean
  liveKeys: string[]
  retired: RetiredKeyOwner[]
}) => {
  const router = useRouter()
  const request = useMutate()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [changingKey, setChangingKey] = useState(false)
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
    const result = await request(`/api/v1/projects/${projectKey}`, {
      method: 'PATCH',
      body: { status },
    })
    if (!result.ok) return
    // Archiving removes it from the sidebar, so staying on its page would
    // leave the nav showing nothing selected. Go home — and refresh, or the
    // layout keeps serving the project list it already had.
    if (status === 'archived') router.replace('/')
    router.refresh()
  }

  const rename = async () => {
    const next = draft.trim()
    setRenaming(false)
    if (!next || next === title) return
    const result = await request(`/api/v1/projects/${projectKey}`, {
      method: 'PATCH',
      body: { title: next },
    })
    if (result.ok) router.refresh()
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
        className="w-[13.75rem] text-ui"
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
        className={`grid size-[1.5rem] place-items-center rounded-md transition-colors duration-[var(--dur-1)] ease-[var(--ease)] ${
          open ? 'bg-surface-hover text-fg' : 'text-fg-subtle hover:text-fg hover:bg-surface-hover'
        }`}
      >
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div
          className="border-border bg-surface pop absolute right-0 top-[1.75rem] z-40 w-[11.25rem] overflow-hidden rounded-lg border py-1 raised"
          style={{ '--origin': 'top right' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setDraft(title)
              setRenaming(true)
            }}
            className="text-fg-muted hover:bg-surface-hover hover:text-fg block w-full px-3 py-1.5 text-left text-ui transition-colors duration-[var(--dur-1)]"
          >
            Rename project
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setChangingKey(true)
            }}
            className="text-fg-muted hover:bg-surface-hover hover:text-fg block w-full px-3 py-1.5 text-left text-ui transition-colors duration-[var(--dur-1)]"
          >
            Change key…
          </button>
          <button
            type="button"
            onClick={() => void setStatus(archived ? 'active' : 'archived')}
            className="text-fg-muted hover:bg-surface-hover hover:text-fg block w-full px-3 py-1.5 text-left text-ui transition-colors duration-[var(--dur-1)]"
          >
            {archived ? 'Restore from archive' : 'Archive project'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setConfirming(true)
            }}
            className="text-danger hover:bg-danger-subtle block w-full px-3 py-1.5 text-left text-ui transition-colors duration-[var(--dur-1)]"
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
      {changingKey && (
        <ChangeKeyDialog
          project={{ id: projectId, key: projectKey, title }}
          liveKeys={liveKeys}
          retired={retired}
          onClose={() => setChangingKey(false)}
          onChanged={(key) => {
            setChangingKey(false)
            // This page's own address just became an old ref. Following it
            // would work — it redirects — but would announce a rename the
            // person made a second ago. Replace, then refresh so the sidebar's
            // project list picks up the new key.
            router.replace(`/projects/${key}`)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
