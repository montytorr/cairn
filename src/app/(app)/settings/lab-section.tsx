'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { StageIcon } from '@/components/lab/stage'
import { TagChip } from '@/components/lab/tag-chip'
import {
  CATEGORY_LABEL, STAGE_CATEGORIES, safeColor,
  type LabSettings, type ProjectRef, type Stage, type StageCategory, type Tag,
} from '@/components/lab/types'
import { Button, Checkbox, Input, Select } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { SettingsCard } from './settings-card'

/** One request, its failure kept as the message the section shows. */
const useWrite = () => {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async (
    url: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: unknown,
    done?: string,
  ) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    const result = await mutate<Record<string, unknown>>(url, { method, body })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return null
    }
    if (done) setMessage(done)
    router.refresh()
    return result.data
  }

  return { send, message, error, busy }
}

const Footer = ({ message, error }: { message: string | null; error: string | null }) =>
  error ? (
    <p role="alert" className="text-danger text-meta">
      {error}
    </p>
  ) : message ? (
    <p className="text-fg-muted enter-rise text-meta">{message}</p>
  ) : undefined

const Swatch = ({
  value,
  onCommit,
  label,
}: {
  value: string
  onCommit: (next: string) => void
  label: string
}) => {
  const [draft, setDraft] = useState(safeColor(value, '#8a8792'))
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(safeColor(value, '#8a8792'))
  }
  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  })

  // The picker fires on every drag; one write per choice, once it settles.
  useEffect(() => {
    if (draft.toLowerCase() === value.toLowerCase()) return
    const timer = setTimeout(() => commit.current(draft.toLowerCase()), 600)
    return () => clearTimeout(timer)
  }, [draft, value])

  return (
    <input
      type="color"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      aria-label={label}
      className="size-[var(--control-h-sm)] shrink-0 cursor-pointer rounded-md"
    />
  )
}

/** The switch and the home project. Turning it off hides; it never deletes. */
const SwitchCard = ({
  settings,
  projects,
}: {
  settings: LabSettings
  projects: ProjectRef[]
}) => {
  const { send, message, error, busy } = useWrite()

  return (
    <SettingsCard
      title="Lab"
      description="Subjects (LAB-12): technologies to evaluate, proofs of concept and ideas, moved through stages to a conclusion. Off, nothing lab-shaped appears anywhere."
      footer={<Footer message={message} error={error} />}
    >
      <div className="flex flex-col gap-4">
        <Checkbox
          label={settings.enabled ? 'The Lab is on' : 'Turn the Lab on'}
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) =>
            void send(
              '/api/v1/lab/settings',
              'PUT',
              { enabled: e.target.checked },
              e.target.checked ? 'The Lab is on.' : 'The Lab is off. Nothing was deleted.',
            )
          }
        />

        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-meta font-medium">Home project for todos</span>
          <Select
            value={settings.home_project?.key ?? ''}
            disabled={busy}
            onChange={(e) =>
              void send(
                '/api/v1/lab/settings',
                'PUT',
                { homeProject: e.target.value || null },
                'Home project saved.',
              )
            }
            className="max-w-sm"
          >
            <option value="">Default: LT, “Lab todos”, created with the first todo</option>
            {projects.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} · {p.title}
              </option>
            ))}
          </Select>
          <span className="text-fg-subtle text-meta">
            A new todo is filed in its subject&apos;s project when it has one, and here otherwise.
          </span>
        </label>
      </div>
    </SettingsCard>
  )
}

const StageRow = ({
  stage,
  index,
  total,
  onMove,
}: {
  stage: Stage
  index: number
  total: number
  onMove: (from: number, to: number) => void
}) => {
  const { send, error, busy } = useWrite()
  const [name, setName] = useState(stage.name)
  const base = `/api/v1/lab/stages/${stage.id}`

  const rename = () => {
    const next = name.trim()
    if (!next || next === stage.name) {
      setName(stage.name)
      return
    }
    void send(base, 'PATCH', { name: next })
  }

  return (
    <li className="row-hover flex min-h-[2.75rem] flex-wrap items-center gap-2 px-4 py-1.5 md:px-5">
      <StageIcon stage={stage} />
      <Input
        size="sm"
        value={name}
        maxLength={40}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setName(stage.name)
        }}
        aria-label={`Name of ${stage.name}`}
        className="min-w-0 flex-1 basis-40"
      />
      <Select
        size="sm"
        value={stage.category}
        disabled={busy}
        onChange={(e) => void send(base, 'PATCH', { category: e.target.value })}
        aria-label={`Category of ${stage.name}`}
        className="w-[8.5rem]"
      >
        {STAGE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABEL[c]}
          </option>
        ))}
      </Select>
      <Swatch
        value={stage.color}
        label={`Colour of ${stage.name}`}
        onCommit={(color) => void send(base, 'PATCH', { color })}
      />
      <span className="flex items-center">
        <Button
          icon
          size="sm"
          variant="ghost"
          disabled={busy || index === 0}
          onClick={() => onMove(index, index - 1)}
          aria-label={`Move ${stage.name} earlier`}
        >
          <ArrowUp size={13} aria-hidden />
        </Button>
        <Button
          icon
          size="sm"
          variant="ghost"
          disabled={busy || index === total - 1}
          onClick={() => onMove(index, index + 1)}
          aria-label={`Move ${stage.name} later`}
        >
          <ArrowDown size={13} aria-hidden />
        </Button>
        <Button
          icon
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => void send(base, 'DELETE')}
          aria-label={`Delete ${stage.name}`}
        >
          <Trash2 size={13} aria-hidden />
        </Button>
      </span>
      {error ? (
        <p role="alert" className="text-danger basis-full pl-6 text-meta">
          {error}
        </p>
      ) : null}
    </li>
  )
}

const StagesCard = ({ stages }: { stages: Stage[] }) => {
  const { send, message, error, busy } = useWrite()
  const [name, setName] = useState('')
  const [category, setCategory] = useState<StageCategory>('active')

  const move = (from: number, to: number) => {
    const ids = stages.map((s) => s.id)
    const [id] = ids.splice(from, 1)
    ids.splice(to, 0, id!)
    void send('/api/v1/lab/stages/reorder', 'POST', { ids })
  }

  const add = async () => {
    const next = name.trim()
    if (!next || busy) return
    const created = await send('/api/v1/lab/stages', 'POST', { name: next, category }, `Added “${next}”.`)
    if (created) setName('')
  }

  return (
    <SettingsCard
      title="Lab stages"
      flush
      description="The pipeline every subject moves along, in this order. A completed or dropped stage asks for a conclusion; a stage that holds subjects cannot be deleted."
      footer={<Footer message={message} error={error} />}
    >
      {stages.length === 0 ? (
        <EmptyState compact title="No stages." />
      ) : (
        <ul className="divide-border stagger divide-y">
          {stages.map((stage, index) => (
            <StageRow key={stage.id} stage={stage} index={index} total={stages.length} onMove={move} />
          ))}
        </ul>
      )}
      <form
        className="border-border flex flex-wrap items-center gap-2 border-t px-4 py-3 md:px-5"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          size="sm"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder="New stage…"
          aria-label="New stage name"
          className="min-w-0 flex-1 basis-40"
        />
        <Select
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as StageCategory)}
          aria-label="New stage category"
          className="w-[8.5rem]"
        >
          {STAGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>
          Add stage
        </Button>
      </form>
    </SettingsCard>
  )
}

const TagRow = ({ tag }: { tag: Tag }) => {
  const { send, error, busy } = useWrite()
  const [name, setName] = useState(tag.name)
  const base = `/api/v1/lab/tags/${tag.id}`

  const rename = () => {
    const next = name.trim().toLowerCase()
    if (!next || next === tag.name) {
      setName(tag.name)
      return
    }
    void send(base, 'PATCH', { name: next })
  }

  return (
    <li className="row-hover flex min-h-[2.75rem] flex-wrap items-center gap-2 px-4 py-1.5 md:px-5">
      <TagChip tag={tag} />
      <Input
        size="sm"
        value={name}
        maxLength={40}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setName(tag.name)
        }}
        aria-label={`Name of ${tag.name}`}
        className="min-w-0 flex-1 basis-40"
      />
      <Swatch
        value={tag.color}
        label={`Colour of ${tag.name}`}
        onCommit={(color) => void send(base, 'PATCH', { color })}
      />
      <Button
        icon
        size="sm"
        variant="danger"
        disabled={busy}
        onClick={() => void send(base, 'DELETE')}
        aria-label={`Delete ${tag.name}`}
      >
        <Trash2 size={13} aria-hidden />
      </Button>
      {error ? (
        <p role="alert" className="text-danger basis-full text-meta">
          {error}
        </p>
      ) : null}
    </li>
  )
}

const TagsCard = ({ tags }: { tags: Tag[] }) => {
  const { send, message, error, busy } = useWrite()
  const [name, setName] = useState('')

  const add = async () => {
    const next = name.trim().toLowerCase()
    if (!next || busy) return
    const created = await send('/api/v1/lab/tags', 'POST', { name: next }, `Added “${next}”.`)
    if (created) setName('')
  }

  return (
    <SettingsCard
      title="Lab tags"
      flush
      description="What a subject is about. Curated here, so the same idea does not carry three spellings. Deleting a tag takes it off every subject."
      footer={<Footer message={message} error={error} />}
    >
      {tags.length === 0 ? (
        <EmptyState compact title="No tags yet." />
      ) : (
        <ul className="divide-border stagger divide-y">
          {tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} />
          ))}
        </ul>
      )}
      <form
        className="border-border flex flex-wrap items-center gap-2 border-t px-4 py-3 md:px-5"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          size="sm"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag…"
          aria-label="New tag name"
          className="min-w-0 flex-1 basis-40"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>
          Add tag
        </Button>
      </form>
    </SettingsCard>
  )
}

/**
 * The Lab's administration, for an administrator: the switch, the project its
 * todos are filed in, and the curated stages and tags. Stages and tags only
 * answer while the Lab is on, so they appear once it is.
 */
export const LabSection = ({
  settings,
  stages,
  tags,
  projects,
}: {
  settings: LabSettings
  stages: Stage[]
  tags: Tag[]
  projects: ProjectRef[]
}) => (
  <>
    <SwitchCard settings={settings} projects={projects} />
    {settings.enabled ? (
      <>
        <StagesCard stages={stages} />
        <TagsCard tags={tags} />
      </>
    ) : null}
  </>
)
