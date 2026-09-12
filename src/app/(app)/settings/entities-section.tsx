'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api/mutate'
import { Button, InlineInput } from '@/components/ui/control'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

export type EntityRow = {
  key: string
  title: string
  projects: string[]
  knowledgeCount: number
}

/**
 * Entities are the scope between one project and everything: a business, a
 * stack, a subsystem. A fact filed against one is visible from every project in
 * it, so this is where "which projects count as Dispofi" actually gets decided.
 *
 * Assigning a fact to a grouping already had UI on the knowledge page; defining
 * the groupings did not, which was backwards — the frequent, low-stakes action
 * was covered and the rare, high-stakes one was CLI-only.
 */
export const EntitiesSection = ({
  entities,
  allProjects,
  unassigned,
}: {
  entities: EntityRow[]
  allProjects: { key: string; title: string }[]
  unassigned: string[]
}) => {
  const router = useRouter()
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newTitle, setNewTitle] = useState('')

  const call = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ knowledgeWidenedToGlobal?: number } | null> => {
    setBusy(true)
    setMessage(null)
    // A key like "Business Unit" is refused by a regex, and the envelope says
    // only "Validation failed" — the useful half is in `issues`, which this
    // never read. `mutate` unpacks it, so the message names the field.
    const result = await mutate<{ knowledgeWidenedToGlobal?: number }>(path, { method, body })
    setBusy(false)
    if (!result.ok) {
      setMessage(result.error)
      return null
    }
    router.refresh()
    return result.data ?? {}
  }

  const toggleProject = async (entity: EntityRow, project: string) => {
    const member = entity.projects.includes(project)
    await call('PATCH', '/api/v1/entities', {
      key: entity.key,
      addProjects: member ? [] : [project],
      removeProjects: member ? [project] : [],
    })
  }

  const create = async () => {
    const key = newKey.trim().toLowerCase()
    if (!key) return
    const done = await call('POST', '/api/v1/entities', {
      key,
      title: newTitle.trim() || key,
    })
    if (done) {
      setCreating(false)
      setNewKey('')
      setNewTitle('')
    }
  }

  const remove = async (entity: EntityRow) => {
    const done = await call('DELETE', `/api/v1/entities?key=${encodeURIComponent(entity.key)}`)
    if (done) {
      setMessage(
        (done.knowledgeWidenedToGlobal ?? 0) > 0
          ? `Deleted “${entity.key}”. ${done.knowledgeWidenedToGlobal} fact(s) are now global rather than scoped to it.`
          : `Deleted “${entity.key}”.`,
      )
    }
  }

  return (
    <section>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium">Entities</h2>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="text-fg-subtle hover:text-fg text-[12px] transition-colors"
        >
          {creating ? 'Cancel' : 'New entity'}
        </button>
      </div>

      <p className="text-fg-subtle mb-3 text-[12px] leading-relaxed">
        A grouping a fact can be true of — a business, a stack, a subsystem. Knowledge filed
        against one is visible from every project in it, which is how something true of all
        of Dispofi stops having to be either filed twenty times or made global.
      </p>

      {creating && (
        <div className="border-border bg-surface mb-3 flex flex-wrap items-center gap-2 rounded-md border p-2.5">
          <InlineInput
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key (lowercase-hyphens)"
            className="w-[200px]"
            aria-label="Entity key"
          />
          <InlineInput
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Title"
            className="w-[200px]"
            aria-label="Entity title"
          />
          <Button size="sm" onClick={create} disabled={busy || !newKey.trim()}>
            Create
          </Button>
        </div>
      )}

      <div className="border-border divide-border divide-y rounded-md border">
        {entities.length === 0 && (
          <p className="text-fg-subtle px-3 py-4 text-[12px]">No entities yet.</p>
        )}

        {entities.map((entity) => (
          <div key={entity.key}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setOpen(open === entity.key ? null : entity.key)}
                className="text-fg min-w-0 text-left text-[13px]"
              >
                {entity.title}{' '}
                <span className="text-fg-subtle font-mono text-[11px]">{entity.key}</span>
              </button>

              <span className="text-fg-subtle ml-auto shrink-0 text-[11px] tabular-nums">
                {entity.projects.length} project{entity.projects.length === 1 ? '' : 's'} ·{' '}
                {entity.knowledgeCount} scoped here
              </span>

              <button
                type="button"
                onClick={() => remove(entity)}
                disabled={busy}
                className="text-fg-subtle hover:text-danger shrink-0 text-[11px] transition-colors"
              >
                Delete
              </button>
            </div>

            {entity.projects.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
                {entity.projects.map((key) => (
                  <span
                    key={key}
                    className="text-fg-muted inline-flex items-center gap-1 text-[11px]"
                  >
                    <ProjectIcon size={10} projectKey={key} />
                    {key}
                  </span>
                ))}
              </div>
            )}

            {open === entity.key && (
              <div className="border-border bg-surface border-t px-3 py-2.5">
                <p className="text-fg-subtle mb-2 text-[11px]">
                  Click a project to add or remove it. A project can belong to several
                  entities at once.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {allProjects.map((p) => {
                    const member = entity.projects.includes(p.key)
                    return (
                      <button
                        key={p.key}
                        type="button"
                        disabled={busy}
                        onClick={() => toggleProject(entity, p.key)}
                        aria-pressed={member}
                        className={cn(
                          'rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
                          member
                            ? 'border-accent text-accent'
                            : 'border-border text-fg-subtle hover:text-fg',
                        )}
                      >
                        {p.key}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {unassigned.length > 0 && (
        <p className="text-fg-subtle mt-2 text-[12px]">
          In no entity at all:{' '}
          <span className="text-fg-muted font-mono">{unassigned.join(' ')}</span> — these see
          only their own knowledge and whatever is global.
        </p>
      )}

      {message && <p className="text-fg-muted mt-2 text-[12px]">{message}</p>}
    </section>
  )
}
