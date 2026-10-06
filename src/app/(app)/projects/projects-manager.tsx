'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'
import { Archive, ArchiveRestore, Check, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'
import { ProjectIcon } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { ChangeKeyDialog, type RetiredKeyOwner } from '@/components/change-key-dialog'
import { useMutate } from '@/lib/api/use-mutate'
import { shortDateWithYear } from '@/lib/dates'
import { PROJECT_KEY_RULE as KEY_RULE, renameLine, renamesOf, type RetiredKey } from '@/lib/project-rename'
import { cn } from '@/lib/utils'

type Row = {
  id: string
  key: string
  title: string
  description: string | null
  status: string
  open: number
  total: number
  formerKeys: RetiredKey[]
}

/**
 * `formerly AC · 22 Sept 2026`, beside the live key. A rename that is only
 * recorded is found by the people who already know it happened; this is where
 * everyone else looks up what a project is called.
 */
const FormerlyLabel = ({ row }: { row: Row }) => {
  const renames = renamesOf(row.formerKeys, row.key)
  const last = renames.at(-1)
  if (!last) return null
  return (
    <span
      className="text-fg-subtle min-w-0 truncate text-meta"
      title={renames.map((r) => renameLine(r)).join('\n')}
    >
      formerly {renames.map((r) => r.from).join(', ')} · {shortDateWithYear(last.at)}
    </span>
  )
}

/**
 * Create a project, and keep the list tidy afterwards.
 *
 * The key field is the interesting one: it is the prefix of every ref the
 * project will ever issue, so it is validated here as well as by the server —
 * not to be clever, but because being told the rule after typing a title and
 * a description is a worse way to learn it.
 */
export const ProjectsManager = ({
  projects,
  retired,
}: {
  projects: Row[]
  retired: RetiredKeyOwner[]
}) => {
  const router = useRouter()
  const send = useMutate()

  const [creating, setCreating] = useState(false)
  const [key, setKey] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState('')
  const [changingKey, setChangingKey] = useState<string | null>(null)

  // A retired key is as taken as a live one: the server refuses it, because
  // every ref already issued under it would then lead to two tasks.
  const retiredBy = retired.find((r) => r.key === key.toUpperCase())
  const keyTaken = projects.some((p) => p.key === key.toUpperCase()) || Boolean(retiredBy)
  const keyValid = KEY_RULE.test(key.toUpperCase()) && !keyTaken

  const create = async () => {
    if (!keyValid || !title.trim() || busy) return
    setBusy(true)
    const result = await send('/api/v1/projects', {
      method: 'POST',
      body: { key: key.toUpperCase(), title: title.trim() },
    })
    setBusy(false)
    if (!result.ok) return
    setKey('')
    setTitle('')
    setCreating(false)
    router.refresh()
  }

  const rename = async (row: Row) => {
    const next = draft.trim()
    setEditing(null)
    if (!next || next === row.title) return
    const result = await send(`/api/v1/projects/${row.key}`, {
      method: 'PATCH',
      body: { title: next },
    })
    if (result.ok) router.refresh()
  }

  const setStatus = async (row: Row, status: string) => {
    const result = await send(`/api/v1/projects/${row.key}`, { method: 'PATCH', body: { status } })
    if (result.ok) router.refresh()
  }

  const remove = async (row: Row) => {
    const result = await send(
      `/api/v1/projects/${row.key}?confirm=${encodeURIComponent(row.key)}`,
      { method: 'DELETE' },
    )
    setConfirming(null)
    setConfirmKey('')
    if (result.ok) router.refresh()
  }

  const active = projects.filter((p) => p.status !== 'archived')
  const archived = projects.filter((p) => p.status === 'archived')

  const row = (p: Row) => (
    <li
      key={p.id}
      className="border-border row-hover group flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
    >
      <ProjectIcon size={15} projectKey={p.key} />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {editing === p.id ? (
          <InlineInput
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => rename(p)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(p)
              if (e.key === 'Escape') setEditing(null)
            }}
            className="max-w-[22rem]"
          />
        ) : (
          <Link
            href={`/projects/${p.key}`}
            className="text-fg hover:text-accent min-w-0 truncate text-ui font-medium transition-colors duration-[var(--dur-1)]"
          >
            {p.title}
          </Link>
        )}
        <span className="text-fg-subtle tabular shrink-0 text-meta">{p.key}</span>
        <FormerlyLabel row={p} />
      </div>

      <span className="text-fg-subtle tabular shrink-0 text-meta">
        {p.open} open{p.total !== p.open ? ` · ${p.total} total` : ''}
      </span>

      {/* Visible on hover at a pointer, always visible on touch, where there
          is no hover and an invisible control is an absent one. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity duration-[var(--dur-1)] ease-[var(--ease-out)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <Button
          size="sm"
          variant="ghost"
          title="Rename"
          onClick={() => {
            setEditing(p.id)
            setDraft(p.title)
          }}
        >
          <Pencil size={13} aria-hidden />
          <span className="sr-only">Rename {p.key}</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          title="Change key — old refs keep working"
          onClick={() => setChangingKey(p.id)}
        >
          <KeyRound size={13} aria-hidden />
          <span className="sr-only">Change key of {p.key}</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          title={p.status === 'archived' ? 'Restore' : 'Archive — hides it, tasks stay searchable'}
          onClick={() => setStatus(p, p.status === 'archived' ? 'active' : 'archived')}
        >
          {p.status === 'archived' ? (
            <ArchiveRestore size={13} aria-hidden />
          ) : (
            <Archive size={13} aria-hidden />
          )}
          <span className="sr-only">{p.status === 'archived' ? 'Restore' : 'Archive'} {p.key}</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="hover:bg-danger-subtle hover:text-danger"
          title="Delete"
          onClick={() => {
            setConfirming(p.id)
            setConfirmKey('')
          }}
        >
          <Trash2 size={13} aria-hidden />
          <span className="sr-only">Delete {p.key}</span>
        </Button>
      </div>
    </li>
  )

  const target = projects.find((p) => p.id === confirming)
  const rekeying = projects.find((p) => p.id === changingKey)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-fg text-ui font-medium">Active</h2>
        {creating ? null : (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={13} aria-hidden />
            New project
          </Button>
        )}
      </div>

      {creating && (
        <div className="surface-card enter-rise flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-start gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-fg-subtle text-meta font-medium">Key</span>
              <InlineInput
                autoFocus
                value={key}
                placeholder="ACME"
                maxLength={10}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                className="w-[7rem] uppercase"
              />
            </label>
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
              <span className="text-fg-subtle text-meta font-medium">Title</span>
              <InlineInput
                value={title}
                placeholder="What this project is"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
              />
            </label>
            <div className="flex items-end gap-1 self-stretch">
              <Button variant="primary" disabled={!keyValid || !title.trim() || busy} onClick={create}>
                <Check size={13} aria-hidden />
                Create
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                <X size={13} aria-hidden />
                <span className="sr-only">Cancel</span>
              </Button>
            </div>
          </div>

          <p className={cn('text-meta', keyTaken ? 'text-danger' : 'text-fg-subtle')}>
            {retiredBy
              ? `${retiredBy.key} used to be ${retiredBy.current}'s key and can never be reused — every ${retiredBy.key}-n ref still leads to ${retiredBy.current}.`
              : keyTaken
              ? `${key.toUpperCase()} is already in use.`
              : 'The key prefixes every ref this project issues — ACME-1, ACME-2. Two to ten characters, starting with a letter. Changing it later keeps old refs working, but it is worth getting right.'}
          </p>
        </div>
      )}

      <ul className="surface-card stagger overflow-hidden">
        {active.length > 0 ? (
          active.map(row)
        ) : (
          <li>
            <EmptyState title="No active projects yet." />
          </li>
        )}
      </ul>

      {archived.length > 0 && (
        <>
          <h2 className="text-fg-muted text-ui font-medium">Archived</h2>
          <ul className="surface-card overflow-hidden opacity-70 transition-opacity duration-[var(--dur-2)] ease-[var(--ease-out)] hover:opacity-100">
            {archived.map(row)}
          </ul>
        </>
      )}

      {rekeying && (
        <ChangeKeyDialog
          project={rekeying}
          liveKeys={projects.map((p) => p.key)}
          retired={retired}
          onClose={() => setChangingKey(null)}
          onChanged={() => {
            setChangingKey(null)
            router.refresh()
          }}
        />
      )}

      {target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setConfirming(null)}
        >
          <div className="scrim absolute inset-0" aria-hidden />
          <div
            className="border-border bg-surface raised-lg enter-sheet relative flex w-full max-w-[26rem] flex-col overflow-hidden rounded-xl border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="border-border text-fg border-b px-4 py-3 text-ui font-medium">
              Delete {target.key}?
            </h3>
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <p className="text-fg-muted text-ui leading-relaxed">
                This removes <strong className="text-fg">{target.total}</strong>{' '}
                {target.total === 1 ? 'task' : 'tasks'} and everything attached to them — notes,
                comments, attachments and history. It cannot be undone.
              </p>
              <p className="text-fg-subtle text-meta">
                Archiving hides a project and keeps its tasks searchable. If you only want it out of
                the way, close this and archive it instead.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-fg-subtle text-meta font-medium">
                  Type {target.key} to confirm
                </span>
                <InlineInput
                  autoFocus
                  value={confirmKey}
                  onChange={(e) => setConfirmKey(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && confirmKey === target.key && remove(target)}
                />
              </label>
            </div>
            <div className="border-border bg-surface-raised/40 flex justify-end gap-2 border-t px-4 py-3">
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={confirmKey !== target.key}
                onClick={() => remove(target)}
              >
                Delete permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
