'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, ChevronRight, Info, ShieldCheck, Undo2, X } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { LabelPill, ProjectIcon, entityColor, projectColor } from '@/components/icons'
import { Button, Field, Input, Select, Textarea } from '@/components/ui/control'
import { LabelEditor } from '../../projects/[key]/label-editor'
import { fullDateTime, shortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { KnowledgePicker } from '@/components/knowledge-picker'
import { TintPill } from '../knowledge-list'

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
  createdAt: string
  /** Who recorded it — an agent identity, or a person. */
  author: string | null
  /** The task it was learned on, if it was learned on one. */
  sourceTask: { ref: string; title: string } | null
}

/** A version an edit replaced, and the edit that replaced it (CAIRN-266). */
type Revision = {
  revision: number
  title: string
  body: string
  change: 'relearned' | 'rescoped' | 'superseded' | 'reinstated'
  editedBy: string | null
  editedAt: string
  reason: string | null
}

type KeyTitle = { key: string; title: string }

/** A scope chip that is also a link brightens its text under the pointer. */
const CHIP_LINK = 'inline-flex rounded-full [&>span]:transition-colors hover:[&>span]:text-fg'

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
  return json.data as { warnings?: string[] } | null
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
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.75rem] transition-colors',
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
    {options.length === 0 && <span className="text-fg-subtle text-[0.75rem]">None defined.</span>}
  </div>
)

export const KnowledgeDetail = ({
  slug,
  row,
  allProjects,
  allEntities,
  allLabels,
  suggestedEntities,
  revisions,
  recall,
}: {
  slug: string
  row: Row
  revisions: Revision[]
  recall: { days: number; returned: number; read: number; lastRecalled: string | null; counted: string }
  allProjects: KeyTitle[]
  allEntities: KeyTitle[]
  allLabels: string[]
  suggestedEntities: string[]
}) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * What the save accepted but still had something to say about: a reference
   * to nothing, or to an entry somebody has superseded (CAIRN-347). The CLI
   * prints these on stderr; this page read `data` and dropped them, so the one
   * surface a person edits on was the one that never heard.
   */
  const [warnings, setWarnings] = useState<string[]>([])
  const [current, setCurrent] = useState(row)

  const [draftTitle, setDraftTitle] = useState(row.title)
  const [draftBody, setDraftBody] = useState(row.body)
  const [draftLabels, setDraftLabels] = useState(row.labels)
  const [draftProjects, setDraftProjects] = useState(row.projects)
  const [draftEntities, setDraftEntities] = useState(row.entities)
  const [draftVerified, setDraftVerified] = useState(row.verified)

  const [supersedeTarget, setSupersedeTarget] = useState('')
  const [supersedeTitle, setSupersedeTitle] = useState('')
  const [supersedeBusy, setSupersedeBusy] = useState(false)

  const startEdit = () => {
    setDraftTitle(current.title)
    setDraftBody(current.body)
    setDraftLabels(current.labels)
    setDraftProjects(current.projects)
    setDraftEntities(current.entities)
    setDraftVerified(current.verified)
    setError(null)
    setWarnings([])
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setWarnings([])
    try {
      const saved = await patch(slug, {
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
      setWarnings(saved?.warnings ?? [])
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
      const target = supersedeTitle ? { slug: supersedeTarget, title: supersedeTitle } : null
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
    <div className="mx-auto max-w-[45rem] px-4 py-6 sm:px-6">
      {current.superseded && (
        <div className="surface-card text-fg-muted enter-rise mb-4 flex flex-wrap items-center gap-1.5 px-3 py-2 text-[0.78125rem]">
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
            className="text-fg-subtle hover:text-fg ml-auto inline-flex items-center gap-1 transition-colors disabled:opacity-50"
          >
            <Undo2 size={12} aria-hidden />
            Undo
          </button>
        </div>
      )}

      {error && !editing && (
        <p
          role="alert"
          className="text-danger bg-danger-subtle mb-4 rounded-md px-3 py-2 text-[0.78125rem] whitespace-pre-line"
        >
          {error}
        </p>
      )}

      {/* Saved, with a remark — the same quiet card as the superseded notice
          above, because nothing failed. Kept until dismissed or the next
          edit: it names references to fix, and a toast would time out first. */}
      {warnings.length > 0 && (
        <div
          role="status"
          className="surface-card text-fg-muted enter-rise mb-4 flex items-start gap-2 px-3 py-2 text-[0.78125rem]"
        >
          <Info size={13} className="mt-[0.1875rem] shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-fg">Saved. Some references need a look:</p>
            <ul className="mt-1 flex flex-col gap-0.5 leading-relaxed break-words">
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => setWarnings([])}
            aria-label="Dismiss"
            className="text-fg-subtle hover:text-fg -mr-1 grid size-5 shrink-0 place-items-center rounded transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {!editing ? (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h1
              className={cn(
                'font-display headline text-fg text-[1.375rem] leading-snug',
                current.superseded && 'text-fg-muted line-through decoration-1',
              )}
            >
              {current.title}
            </h1>
            <Button size="sm" onClick={startEdit} className="mt-0.5 shrink-0">
              Edit
            </Button>
          </div>

          {/* Everything said ABOUT the fact, in one card above it: its state
              and scope on the first line, where it came from on the second.
              The body below then reads uninterrupted. */}
          <div className="surface-card mb-6 text-[0.75rem]">
            <div className="text-fg-subtle flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              {current.verified && (
                <TintPill color="var(--status-in-review)" className="text-status-in-review">
                  <ShieldCheck size={11} aria-hidden /> Verified
                </TintPill>
              )}
              <time dateTime={current.updatedAt} title={fullDateTime(current.updatedAt)}>
                Updated {shortDate(current.updatedAt)}
              </time>
              {/* Both, not one or the other. A fact scoped to a project AND an
                  entity showed only its projects here, so the entity was
                  invisible until somebody clicked Edit. And these are links
                  now: the whole point of a scope is the rest of what shares
                  it, and reaching that was a URL you had to know. Entities
                  have no page of their own, so they go where the project
                  header already sends them. */}
              <span className="flex flex-wrap items-center gap-1">
                {current.projects.map((p) => (
                  <Link key={p} href={`/projects/${p}`} className={CHIP_LINK}>
                    <TintPill color={projectColor(p)}>
                      <ProjectIcon size={10} projectKey={p} />
                      {p}
                    </TintPill>
                  </Link>
                ))}
                {current.entities.map((e) => (
                  <Link
                    key={e}
                    href={`/knowledge?entity=${encodeURIComponent(e)}`}
                    className={CHIP_LINK}
                  >
                    <TintPill color={entityColor(e)}>
                      <span
                        aria-hidden
                        className="size-[0.4375rem] rounded-full"
                        style={{ backgroundColor: entityColor(e) }}
                      />
                      {e}
                    </TintPill>
                  </Link>
                ))}
                {current.projects.length === 0 && current.entities.length === 0 && (
                  <TintPill color="var(--fg-subtle)" className="text-fg-subtle italic">
                    global
                  </TintPill>
                )}
              </span>
              {current.labels.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  {current.labels.map((l) => (
                    <LabelPill key={l}>{l}</LabelPill>
                  ))}
                </span>
              )}
            </div>

            {/* The slug is the name this fact has. It lived only in the URL,
                while being the exact string an agent types to fetch it and the
                one that goes inside [[...]] to reference it. */}
            <div className="border-border/70 text-fg-subtle flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-3 py-2 text-[0.6875rem]">
              <code className="bg-surface-raised text-fg-muted rounded px-1.5 py-0.5 font-mono">{slug}</code>
              {current.sourceTask && (
                <span>
                  learned on{' '}
                  <Link
                    href={`/projects/${current.sourceTask.ref.split('-')[0]}/tasks/${current.sourceTask.ref.split('-').slice(1).join('-')}`}
                    className="text-accent font-mono decoration-1 underline-offset-2 hover:underline"
                    title={current.sourceTask.title}
                  >
                    {current.sourceTask.ref}
                  </Link>
                </span>
              )}
              {current.author && <span>recorded by {current.author}</span>}
              <time dateTime={current.createdAt} title={fullDateTime(current.createdAt)}>
                first written {shortDate(current.createdAt)}
              </time>
              {/* How often it is handed to anyone (CAIRN-270), and what that
                  leaves out — a fact the briefing shows daily would otherwise
                  read as unused. */}
              <span className="tabular-nums" title={`Last ${recall.days} days: ${recall.counted}.`}>
                {recall.returned + recall.read === 0
                  ? `not recalled in ${recall.days} days`
                  : `recalled ${recall.returned + recall.read}× in ${recall.days} days (${recall.returned} search, ${recall.read} read)`}
                {recall.lastRecalled && recall.returned + recall.read === 0
                  ? ` · last ${shortDate(recall.lastRecalled)}`
                  : ''}
              </span>
            </div>
          </div>

          <MarkdownView>{current.body || '_No body yet._'}</MarkdownView>

          {revisions.length > 0 && (
            <details className="group/history border-border/70 mt-8 border-t pt-4">
              <summary className="text-fg-muted hover:text-fg flex cursor-pointer list-none items-center gap-1.5 text-[0.75rem] transition-colors [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={12}
                  aria-hidden
                  className="text-fg-subtle transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)] group-open/history:rotate-90"
                />
                {revisions.length} earlier version{revisions.length === 1 ? '' : 's'} — this is
                version {(revisions[0]?.revision ?? 0) + 1}
              </summary>
              {/* The history as a short trail: one stone per version it
                  replaced, joined by the same dotted line as the activity
                  feed, newest at the top. */}
              <ol className="enter-rise mt-3 flex flex-col">
                {revisions.map((r) => (
                  <li key={r.revision} className="group/rev relative pb-4 pl-5 last:pb-0">
                    <span
                      aria-hidden
                      className="absolute top-0 bottom-0 left-[3.5px] w-px bg-[linear-gradient(to_bottom,var(--border-strong)_40%,transparent_0)] bg-[length:1px_5px] group-first/rev:top-[0.4375rem] group-last/rev:bottom-auto group-last/rev:h-[0.4375rem] group-only/rev:hidden"
                    />
                    <span
                      aria-hidden
                      className="bg-fg-subtle absolute top-[0.25rem] left-0 h-1.5 w-2 rounded-full"
                    />
                    <div className="text-fg-subtle flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]">
                      <span className="text-fg-muted font-mono tabular-nums">v{r.revision}</span>
                      <span>
                        replaced{r.editedBy ? ` by ${r.editedBy}` : ''} ·{' '}
                        <time dateTime={r.editedAt} title={fullDateTime(r.editedAt)}>
                          {shortDate(r.editedAt)}
                        </time>{' '}
                        · {r.change}
                      </span>
                    </div>
                    {r.reason && <p className="text-fg-muted mt-1 text-[0.75rem]">{r.reason}</p>}
                    <details className="mt-1">
                      <summary className="text-fg hover:text-accent cursor-pointer text-[0.78125rem] transition-colors">
                        {r.title}
                      </summary>
                      <div className="surface-card mt-2 px-3 py-2.5">
                        <MarkdownView>{r.body || '_No body._'}</MarkdownView>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {!current.superseded && (
            <div className="border-border/70 mt-8 flex flex-wrap items-center gap-2 border-t pt-4">
              <span className="text-fg-subtle text-[0.75rem]">Mark superseded by:</span>
              {/* Searched, not listed. This was a select holding every current
                  entry, which is unusable at 348 and was silently capped at
                  300 — so a corrected fact could point at 300 of its possible
                  replacements and there was no way to tell. */}
              <KnowledgePicker
                exclude={slug}
                placeholder="Search for the entry that replaces this…"
                onPick={(hit) => {
                  setSupersedeTarget(hit.slug)
                  setSupersedeTitle(hit.title)
                }}
              />
              {supersedeTarget && (
                <span className="text-fg enter-rise flex items-center gap-1 text-[0.75rem]">
                  <span className="text-fg-subtle">→</span>
                  <span className="max-w-[16rem] truncate">{supersedeTitle || supersedeTarget}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSupersedeTarget('')
                      setSupersedeTitle('')
                    }}
                    className="text-fg-subtle hover:text-fg"
                    aria-label="Clear the chosen entry"
                  >
                    ×
                  </button>
                </span>
              )}
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
                <p className="text-fg-subtle mt-1.5 text-[0.6875rem]">
                  Suggested, from the projects above: {suggestedEntities.join(', ')}
                </p>
              )}
            </>
          </Field>

          <label className="text-fg-muted flex items-center gap-2 text-[0.78125rem]">
            <input
              type="checkbox"
              checked={draftVerified}
              onChange={(e) => setDraftVerified(e.target.checked)}
              className="accent-accent size-[0.875rem]"
            />
            Verified — this has been checked, not just recorded
          </label>

          {/* A refused save is said beside the button that was pressed. At the
              top of the page it sat a full editor's height above the click,
              out of view, so a refusal from the reference check looked like a
              save that did nothing (CAIRN-347). */}
          {error && (
            <p
              role="alert"
              className="text-danger bg-danger-subtle rounded-md px-3 py-2 text-[0.78125rem] whitespace-pre-line"
            >
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={save} disabled={saving || !draftTitle.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
