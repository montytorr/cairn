'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, ShieldCheck, Undo2 } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { LabelPill, ProjectIcon } from '@/components/icons'
import { Button, Field, Input, Select, Textarea } from '@/components/ui/control'
import { LabelEditor } from '../../projects/[key]/label-editor'
import { fullDateTime, shortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

type Row = {
  title: string
  body: string
  labels: string[]
  projects: string[]
  entities: string[]
  verified: boolean
  updatedAt: string
  superseded: boolean
  supersededByRef: { slug: string; title: string } | null
}

type KeyTitle = { key: string; title: string }
type SlugTitle = { slug: string; title: string }

const patch = async (slug: string, body: Record<string, unknown>) => {
  const res = await fetch(`/api/v1/knowledge/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) {
    throw new Error(json?.error ?? 'The update was refused.')
  }
  return json.data
}

/** A wrapping list of toggleable chips — projects and entities are small
 *  enough sets that a real multi-select control would be more chrome than
 *  content, and a native `<select multiple>` is unusable at 390px. */
const ChipToggle = ({
  options,
  selected,
  onToggle,
  render,
}: {
  options: KeyTitle[]
  selected: string[]
  onToggle: (key: string) => void
  render?: (key: string) => React.ReactNode
}) => (
  <div className="flex flex-wrap gap-1.5">
    {options.map((o) => {
      const active = selected.includes(o.key)
      return (
        <button
          key={o.key}
          type="button"
          onClick={() => onToggle(o.key)}
          aria-pressed={active}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
            active
              ? 'border-accent bg-accent-subtle text-accent'
              : 'border-border text-fg-muted hover:border-border-strong hover:bg-surface-hover',
          )}
        >
          {render?.(o.key)}
          {o.title}
        </button>
      )
    })}
    {options.length === 0 && <span className="text-fg-subtle text-[12px]">None defined.</span>}
  </div>
)

export const KnowledgeDetail = ({
  slug,
  row,
  allProjects,
  allEntities,
  allLabels,
  candidates,
  suggestedEntities,
}: {
  slug: string
  row: Row
  allProjects: KeyTitle[]
  allEntities: KeyTitle[]
  allLabels: string[]
  candidates: SlugTitle[]
  suggestedEntities: string[]
}) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(row)

  const [draftTitle, setDraftTitle] = useState(row.title)
  const [draftBody, setDraftBody] = useState(row.body)
  const [draftLabels, setDraftLabels] = useState(row.labels)
  const [draftProjects, setDraftProjects] = useState(row.projects)
  const [draftEntities, setDraftEntities] = useState(row.entities)
  const [draftVerified, setDraftVerified] = useState(row.verified)

  const [supersedeTarget, setSupersedeTarget] = useState('')
  const [supersedeBusy, setSupersedeBusy] = useState(false)

  const startEdit = () => {
    setDraftTitle(current.title)
    setDraftBody(current.body)
    setDraftLabels(current.labels)
    setDraftProjects(current.projects)
    setDraftEntities(current.entities)
    setDraftVerified(current.verified)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await patch(slug, {
        title: draftTitle,
        body: draftBody,
        labels: draftLabels,
        projects: draftProjects,
        entities: draftEntities,
        verified: draftVerified,
      })
      setCurrent({
        ...current,
        title: draftTitle,
        body: draftBody,
        labels: draftLabels,
        projects: draftProjects,
        entities: draftEntities,
        verified: draftVerified,
      })
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The update was refused.')
    } finally {
      setSaving(false)
    }
  }

  const supersede = async () => {
    if (!supersedeTarget) return
    setSupersedeBusy(true)
    setError(null)
    try {
      await patch(slug, { supersededBy: supersedeTarget })
      const target = candidates.find((c) => c.slug === supersedeTarget)
      setCurrent({
        ...current,
        superseded: true,
        supersededByRef: target ? { slug: target.slug, title: target.title } : null,
      })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark this superseded.')
    } finally {
      setSupersedeBusy(false)
    }
  }

  const unsupersede = async () => {
    setSupersedeBusy(true)
    setError(null)
    try {
      await patch(slug, { supersededBy: null })
      setCurrent({ ...current, superseded: false, supersededByRef: null })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that.')
    } finally {
      setSupersedeBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 py-6 sm:px-6">
      {current.superseded && (
        <div className="border-border bg-surface-raised text-fg-muted mb-4 flex flex-wrap items-center gap-1.5 rounded-md border px-3 py-2 text-[12.5px]">
          <span>This entry is superseded.</span>
          {current.supersededByRef ? (
            <Link
              href={`/knowledge/${current.supersededByRef.slug}`}
              className="text-accent inline-flex items-center gap-1 hover:underline"
            >
              <ArrowRight size={12} aria-hidden />
              {current.supersededByRef.title}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={unsupersede}
            disabled={supersedeBusy}
            className="text-fg-subtle hover:text-fg ml-auto inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Undo2 size={12} aria-hidden />
            Undo
          </button>
        </div>
      )}

      {error && (
        <p className="text-danger bg-danger-subtle mb-4 rounded-md px-3 py-2 text-[12.5px]">
          {error}
        </p>
      )}

      {!editing ? (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h1
              className={cn(
                'text-fg text-[19px] font-semibold tracking-tight',
                current.superseded && 'text-fg-muted line-through decoration-1',
              )}
            >
              {current.title}
            </h1>
            <Button size="sm" onClick={startEdit} className="shrink-0">
              Edit
            </Button>
          </div>

          <div className="text-fg-subtle mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
            {current.verified && (
              <span className="text-status-in-review inline-flex items-center gap-1">
                <ShieldCheck size={12} aria-hidden /> Verified
              </span>
            )}
            <time dateTime={current.updatedAt} title={fullDateTime(current.updatedAt)}>
              Updated {shortDate(current.updatedAt)}
            </time>
            {current.projects.length > 0 ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {current.projects.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1">
                    <ProjectIcon size={11} projectKey={p} />
                    {p}
                  </span>
                ))}
              </span>
            ) : current.entities.length > 0 ? (
              <span>{current.entities.join(', ')}</span>
            ) : (
              <span className="italic">global</span>
            )}
            {current.labels.map((l) => (
              <LabelPill key={l}>{l}</LabelPill>
            ))}
          </div>

          <MarkdownView>{current.body || '_No body yet._'}</MarkdownView>

          {!current.superseded && (
            <div className="border-border mt-8 flex flex-wrap items-center gap-2 border-t pt-4">
              <span className="text-fg-subtle text-[12px]">Mark superseded by:</span>
              <Select
                size="sm"
                value={supersedeTarget}
                onChange={(e) => setSupersedeTarget(e.target.value)}
                aria-label="Replacement entry"
                className="w-auto max-w-[220px]"
              >
                <option value="">Choose an entry…</option>
                {candidates.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.title}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                onClick={supersede}
                disabled={!supersedeTarget || supersedeBusy}
              >
                Supersede
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Title">
            <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
          </Field>

          <Field label="Body (markdown)">
            <Textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={14}
            />
          </Field>

          <Field label="Labels">
            <LabelEditor
              taskRef={slug}
              labels={draftLabels}
              known={allLabels}
              onChange={setDraftLabels}
            />
          </Field>

          <Field label="Projects">
            <ChipToggle
              options={allProjects}
              selected={draftProjects}
              onToggle={(key) =>
                setDraftProjects((prev) =>
                  prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
                )
              }
              render={(key) => <ProjectIcon size={11} projectKey={key} />}
            />
          </Field>

          <Field label="Entities">
            <>
              <ChipToggle
                options={allEntities}
                selected={draftEntities}
                onToggle={(key) =>
                  setDraftEntities((prev) =>
                    prev.includes(key) ? prev.filter((e) => e !== key) : [...prev, key],
                  )
                }
              />
              {suggestedEntities.length > 0 && (
                <p className="text-fg-subtle mt-1.5 text-[11px]">
                  Suggested, from the projects above: {suggestedEntities.join(', ')}
                </p>
              )}
            </>
          </Field>

          <label className="text-fg-muted flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={draftVerified}
              onChange={(e) => setDraftVerified(e.target.checked)}
              className="accent-accent size-[14px]"
            />
            Verified — this has been checked, not just recorded
          </label>

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={save} disabled={saving || !draftTitle.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
