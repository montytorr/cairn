'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api/mutate'
import { Button, InlineInput } from '@/components/ui/control'
import { ProjectIcon } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { SettingsCard } from './settings-card'
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
 * it, so this is where "which projects count as one business" actually gets decided.
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
    <SettingsCard
      title="Entities"
      flush
      description={
        <>A group of projects, such as a business or a stack, that share what they know.</>
      }
      action={
        <Button size="sm" variant="quiet" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New entity'}
        </Button>
      }
      footer={
        unassigned.length > 0 || message ? (
          <div className="flex min-w-0 flex-col gap-1">
            {unassigned.length > 0 && (
              <p className="text-fg-subtle text-meta">
                Not in any group: <span className="text-fg-muted font-mono">{unassigned.join(' ')}</span>
              </p>
            )}
            {message && <p className="text-fg-muted enter-rise text-meta">{message}</p>}
          </div>
        ) : undefined
      }
    >
      {creating && (
        <div className="border-border bg-surface-raised/40 enter-rise flex flex-wrap items-center gap-2 border-b px-4 py-2.5 md:px-5">
          <InlineInput
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key (lowercase-hyphens)"
            className="w-[12.5rem]"
            aria-label="Entity key"
          />
          <InlineInput
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Title"
            className="w-[12.5rem]"
            aria-label="Entity title"
          />
          <Button size="sm" onClick={create} disabled={busy || !newKey.trim()}>
            Create
          </Button>
        </div>
      )}

      {entities.length === 0 ? (
        <EmptyState compact title="No entities yet." />
      ) : (
        <div className="divide-border stagger divide-y">
          {entities.map((entity) => (
            <div key={entity.key} className="row-hover group">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 md:px-5">
                <button
                  type="button"
                  onClick={() => setOpen(open === entity.key ? null : entity.key)}
                  aria-expanded={open === entity.key}
                  className="text-fg min-w-0 text-left text-ui"
                >
                  {entity.title}{' '}
                  <span className="text-fg-subtle font-mono text-meta">{entity.key}</span>
                </button>

                <span className="text-fg-subtle ml-auto shrink-0 text-meta tabular-nums">
                  {entity.projects.length} project{entity.projects.length === 1 ? '' : 's'} ·{' '}
                  {entity.knowledgeCount} scoped here
                </span>

                <button
                  type="button"
                  onClick={() => remove(entity)}
                  disabled={busy}
                  className="text-fg-subtle hover:text-danger shrink-0 text-meta transition-[color,opacity] duration-[var(--dur-1)] ease-[var(--ease-out)] md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                >
                  Delete
                </button>
              </div>

              {entity.projects.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 pb-2.5 md:px-5">
                  {entity.projects.map((key) => (
                    <span
                      key={key}
                      className="text-fg-muted inline-flex items-center gap-1 text-meta"
                    >
                      <ProjectIcon size={10} projectKey={key} />
                      {key}
                    </span>
                  ))}
                </div>
              )}

              {open === entity.key && (
                <div className="border-border bg-surface-raised/40 enter-rise border-t px-4 py-2.5 md:px-5">
                  <p className="text-fg-subtle mb-2 text-meta">
                    Click a project to add or remove it.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {allProjects.map((p) => {
                      const member = entity.projects.includes(p.key)
                      return (
                        <Button
                          key={p.key}
                          size="sm"
                          disabled={busy}
                          onClick={() => toggleProject(entity, p.key)}
                          aria-pressed={member}
                        >
                          {p.key}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}
