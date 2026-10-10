'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Archive, ArchiveRestore, Check, ChevronsUpDown, Plus, Tags, Trash2 } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { MarkdownView } from '@/components/markdown'
import { usePeople } from '@/components/people-context'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { Button, InlineInput, Textarea } from '@/components/ui/control'
import { LABEL, ROW, ROW_LABEL } from '@/app/(app)/projects/[key]/tasks/[number]/styles'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import { DeleteSubjectDialog } from './delete-subject-dialog'
import { ProjectLabel } from './project-label'
import { StageBadge } from './stage'
import { TagChip } from './tag-chip'
import { filterTags, tagToCreate } from './tag-picker'
import { useStageMove } from './use-stage-move'
import {
  canDeleteSubject, isConcluding, type ProjectRef, type Stage, type Subject, type Tag,
} from './types'

/**
 * An editable value: the row lights as a list row does, and a chevron says it
 * opens. The invisible select over it is the control, so the platform opens
 * the list and keyboard and touch behave as for any select.
 */
const EDITABLE =
  'row-hover group/edit relative -mx-1.5 flex h-[var(--control-h-sm)] items-center gap-2 overflow-hidden rounded-md px-1.5 ' +
  'has-[:focus-visible]:bg-surface-hover has-[:focus-visible]:shadow-[inset_2px_0_0_var(--accent)]'

const EditableRow = ({
  label,
  select,
  children,
}: {
  label: string
  select: React.ReactNode
  children: React.ReactNode
}) => (
  <div className={EDITABLE}>
    <span className={ROW_LABEL}>{label}</span>
    <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    <ChevronsUpDown
      size={11}
      aria-hidden
      className="text-fg-subtle ml-auto shrink-0 opacity-0 transition-opacity duration-[var(--dur-1)] ease-[var(--ease-out)] group-hover/edit:opacity-100 group-has-[:focus-visible]/edit:opacity-100"
    />
    {select}
  </div>
)

/**
 * The conclusion, the recorded answer. Shown first on the rail once there is
 * one; edited in place. Clearing it is refused by the server while the subject
 * sits in a completed or dropped stage, and the refusal is shown here.
 */
const ConclusionField = ({ subject }: { subject: Subject }) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(subject.conclusion ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const concluding = isConcluding(subject.stage.category)

  const save = async () => {
    const next = value.trim()
    if (next === (subject.conclusion ?? '')) {
      setEditing(false)
      return
    }
    setPending(true)
    setError(null)
    const result = await mutate(`/api/v1/subjects/${subject.ref}`, {
      method: 'PATCH',
      body: { conclusion: next || null },
    })
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setEditing(false)
    router.refresh()
  }

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2 flex items-center gap-2')}>
        Conclusion
        {subject.concluded_at ? (
          <span className="text-fg-subtle text-meta font-normal tracking-normal normal-case">
            <RelativeTime iso={subject.concluded_at} />
          </span>
        ) : null}
      </h2>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={5}
            autoFocus
            aria-label="Conclusion"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full"
          />
          {error ? (
            <p role="alert" className="text-danger text-meta">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending} onClick={() => void save()}>
              {pending ? <Spinner /> : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : subject.conclusion ? (
        <div className="group">
          <MarkdownView>{subject.conclusion}</MarkdownView>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setValue(subject.conclusion ?? '')
              setEditing(true)
            }}
            className="-ml-1.5 mt-1"
          >
            Edit
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-fg-subtle text-meta">
            {concluding
              ? 'This stage ends a subject, and has no conclusion yet.'
              : 'Written when the subject reaches a completed or dropped stage.'}
          </p>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setValue('')
              setEditing(true)
            }}
            className="-ml-1.5"
          >
            Add a conclusion
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * The subject's rail: stage, owner, project and tags, each changed in place;
 * its conclusion; then archive and delete. Tags come from the curated list an
 * administrator keeps, so the picker is a checklist with a filter, and an
 * administrator can add to the list from here, where the need shows up.
 */
export const SubjectProperties = ({
  subject,
  stages,
  tags,
  projects,
  isAdmin,
}: {
  subject: Subject
  stages: Stage[]
  tags: Tag[]
  projects: ProjectRef[]
  isAdmin: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const { people, currentUserId } = usePeople()
  const [pickingTags, setPickingTags] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const onMoved = useCallback(() => router.refresh(), [router])
  const { move, dialog } = useStageMove(onMoved)

  const canDelete = canDeleteSubject(subject, { userId: currentUserId, role: isAdmin ? 'admin' : 'member' })
  const closeDelete = useCallback(() => setDeleting(false), [])
  const deleted = useCallback(() => {
    router.push('/lab')
    router.refresh()
  }, [router])

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true)
    const result = await request(`/api/v1/subjects/${subject.ref}`, { method: 'PATCH', body })
    setBusy(false)
    if (result.ok) router.refresh()
    return result.ok
  }

  const tagNames = subject.tags.map((t) => t.name)
  const toggleTag = (name: string) =>
    void patch({ tags: tagNames.includes(name) ? tagNames.filter((n) => n !== name) : [...tagNames, name] })

  const shownTags = filterTags(tags, tagQuery)
  const creatable = isAdmin ? tagToCreate(tags, tagQuery) : null

  // Onto the curated list, then onto this subject: the reason it was typed.
  const createTag = async (name: string) => {
    setBusy(true)
    const created = await request<Tag>('/api/v1/lab/tags', { method: 'POST', body: { name } })
    setBusy(false)
    if (!created.ok) return
    setTagQuery('')
    await patch({ tags: [...tagNames, created.data.name] })
  }

  const onTagQueryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (tagQuery) setTagQuery('')
      else setPickingTags(false)
      return
    }
    if (e.key !== 'Enter' || busy) return
    e.preventDefault()
    const exact = tags.find((t) => t.name.toLowerCase() === tagQuery.trim().toLowerCase())
    if (exact) {
      toggleTag(exact.name)
      setTagQuery('')
    } else if (creatable) void createTag(creatable)
    else if (shownTags.length === 1) {
      toggleTag(shownTags[0]!.name)
      setTagQuery('')
    }
  }

  const archived = Boolean(subject.archived_at)
  const ownerKnown = subject.owner && people.some((p) => p.id === subject.owner?.id)

  return (
    <div className="flex flex-col gap-5 px-4 py-5">
      <section className="flex flex-col gap-0.5">
        <EditableRow
          label="Stage"
          select={
            <select
              value={subject.stage.id}
              aria-label="Stage"
              onChange={(e) => {
                const stage = stages.find((s) => s.id === e.target.value)
                if (stage && stage.id !== subject.stage.id) void move(subject, stage)
              }}
              className="select-overlay"
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          }
        >
          <StageBadge stage={subject.stage} className="text-fg text-ui" />
        </EditableRow>

        <EditableRow
          label="Owner"
          select={
            <select
              value={subject.owner?.id ?? ''}
              aria-label="Owner"
              disabled={busy}
              onChange={(e) => void patch({ owner: e.target.value || null })}
              className="select-overlay"
            >
              <option value="">Nobody</option>
              {subject.owner && !ownerKnown ? (
                <option value={subject.owner.id}>{subject.owner.name} (inactive)</option>
              ) : null}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === currentUserId ? `${p.name} (you)` : p.name}
                </option>
              ))}
            </select>
          }
        >
          {subject.owner ? (
            <>
              <Avatar name={subject.owner.name} size={16} />
              <span className="text-fg min-w-0 truncate text-ui">
                {subject.owner.name}
                {subject.owner.id === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
              </span>
            </>
          ) : (
            <span className="text-fg-subtle text-ui">Nobody</span>
          )}
        </EditableRow>

        <EditableRow
          label="Project"
          select={
            <select
              value={subject.project?.id ?? ''}
              aria-label="Project"
              disabled={busy}
              onChange={(e) => void patch({ project: e.target.value || null })}
              className="select-overlay"
            >
              <option value="">None</option>
              {subject.project && !projects.some((p) => p.id === subject.project?.id) ? (
                <option value={subject.project.id}>{subject.project.title}</option>
              ) : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          }
        >
          {subject.project ? (
            <ProjectLabel project={subject.project} className="text-ui" />
          ) : (
            <span className="text-fg-subtle text-ui">None</span>
          )}
        </EditableRow>

        <div className={cn(ROW, 'h-auto items-start py-1')}>
          <span className={cn(ROW_LABEL, 'pt-[0.2rem]')}>Tags</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {subject.tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} onRemove={busy ? undefined : () => toggleTag(tag.name)} />
            ))}
            {tags.length > 0 || isAdmin ? (
              <Button
                size="sm"
                variant="quiet"
                aria-expanded={pickingTags}
                onClick={() => {
                  setPickingTags((v) => !v)
                  setTagQuery('')
                }}
              >
                <Tags size={12} aria-hidden />
                {pickingTags ? 'Done' : subject.tags.length ? 'Edit' : 'Add tags'}
              </Button>
            ) : subject.tags.length === 0 ? (
              <span className="text-fg-subtle text-meta">No tags defined yet</span>
            ) : null}
          </div>
        </div>
        {pickingTags ? (
          <div className="border-border bg-surface enter-rise flex flex-col rounded-lg border p-1">
            <InlineInput
              autoFocus
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              onKeyDown={onTagQueryKey}
              maxLength={40}
              placeholder={isAdmin ? 'Find or create a tag…' : 'Find a tag…'}
              aria-label={isAdmin ? 'Find or create a tag' : 'Find a tag'}
              className="mb-1"
            />
            <ul className="border-border flex flex-col border-t pt-1" role="group" aria-label="Tags">
              {shownTags.map((tag) => {
                const on = tagNames.includes(tag.name)
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      disabled={busy}
                      onClick={() => toggleTag(tag.name)}
                      className="hover:bg-surface-hover flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui transition-colors"
                    >
                      <span className="grid size-4 shrink-0 place-items-center">
                        {on ? <Check size={13} strokeWidth={2.5} aria-hidden /> : null}
                      </span>
                      <span
                        aria-hidden
                        className="size-[0.4375rem] shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color || 'var(--fg-subtle)' }}
                      />
                      <span className="text-fg truncate">{tag.name}</span>
                    </button>
                  </li>
                )
              })}
              {creatable ? (
                <li>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void createTag(creatable)}
                    className="hover:bg-surface-hover text-fg-muted hover:text-fg flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui transition-colors"
                  >
                    <Plus size={13} aria-hidden className="shrink-0" />
                    <span className="truncate">
                      Create tag <span className="text-fg font-medium">“{creatable}”</span>
                    </span>
                  </button>
                </li>
              ) : null}
              {shownTags.length === 0 && !creatable ? (
                <li className="text-fg-subtle px-2 py-1.5 text-meta">
                  {tagQuery.trim()
                    ? 'No tag by that name. An administrator keeps the list.'
                    : isAdmin
                      ? 'No tags yet. Type one to create it.'
                      : 'No tags yet.'}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="border-border border-t pt-4">
        <ConclusionField subject={subject} />
      </div>

      <section className="border-border flex flex-col gap-1 border-t pt-3">
        <p className="text-fg-subtle truncate text-meta" title={subject.actor_id}>
          Opened <RelativeTime iso={subject.created_at} /> by {subject.actor_id}
        </p>
        <p className="text-fg-subtle text-meta">
          Updated <RelativeTime iso={subject.updated_at} />
        </p>
      </section>

      <section className="border-border flex flex-col items-start gap-2 border-t pt-3">
        {archived ? (
          <>
            <p className="text-fg-muted text-meta">Archived: off the board, still searchable, not deleted.</p>
            <Button size="sm" disabled={busy} onClick={() => void patch({ archived: false })}>
              <ArchiveRestore size={13} aria-hidden /> Restore to the Lab
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={async () => {
              if (await patch({ archived: true })) router.push('/lab')
            }}
            className="-ml-1.5"
          >
            <Archive size={13} aria-hidden /> Archive subject
          </Button>
        )}
        {canDelete ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
            <Trash2 size={13} aria-hidden /> Delete subject
          </Button>
        ) : null}
      </section>

      {deleting ? (
        <DeleteSubjectDialog
          subjectRef={subject.ref}
          subjectTitle={subject.title}
          todos={subject.todos.open + subject.todos.done}
          onClose={closeDelete}
          onDeleted={deleted}
        />
      ) : null}

      {dialog}
    </div>
  )
}
