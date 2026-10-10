import Link from 'next/link'
import { BookMarked, FileText, FlaskConical, ListTodo, Radio } from 'lucide-react'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { SearchAllRow } from '@/lib/api/search'
import { Highlight, queryTerms } from './highlight'

/**
 * Results across all four stores.
 *
 * The task-only list next door stays as it is because it carries selection and
 * bulk edit, which only mean anything for tasks. This renders the rest in rank
 * order without pretending a session can be bulk-assigned a priority.
 */

const KIND_META: Record<
  SearchAllRow['kind'],
  { label: string; Icon: typeof ListTodo; tone: string; color: string }
> = {
  task: { label: 'Task', Icon: ListTodo, tone: 'text-accent', color: 'var(--accent)' },
  note: { label: 'Note', Icon: FileText, tone: 'text-fg-muted', color: 'var(--fg-muted)' },
  knowledge: {
    label: 'Knowledge',
   
    Icon: BookMarked,
    tone: 'text-status-done',
    color: 'var(--status-done)',
  },
  session: { label: 'Session', Icon: Radio, tone: 'text-fg-subtle', color: 'var(--fg-subtle)' },
  // Green: the one colour no other kind here takes. A subject is a question
  // being answered, and the answer, once there, is its conclusion.
  subject: {
    label: 'Subject',
    Icon: FlaskConical,
    tone: 'text-status-in-review',
    color: 'var(--status-in-review)',
  },
}

/** The kind of a hit, as a small pill in its own colour. */
const KindBadge = ({ kind }: { kind: SearchAllRow['kind'] }) => {
  const { label, color } = KIND_META[kind]
  return (
    <span
      className="inline-flex h-[1rem] shrink-0 items-center rounded-full border px-1.5 text-label font-medium tracking-[0.04em] uppercase"
      style={{
        color,
        backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
        borderColor: `color-mix(in oklab, ${color} 28%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}

/**
 * Where a hit leads. A note lives on its task, so it opens the task — the note
 * ref IS the task ref. A session has no page of its own: its useful content is
 * already the two lines shown here, and a link to a list would be a worse
 * answer than no link.
 */
const hrefFor = (row: SearchAllRow): string | null => {
  if (row.kind === 'task' || row.kind === 'note') {
    const [key, number] = row.ref.split('-')
    return key && number ? `/projects/${key}/tasks/${number}` : null
  }
  if (row.kind === 'knowledge') return `/knowledge/${row.ref}`
  if (row.kind === 'subject') return `/lab/subjects/${row.ref.replace(/^LAB-/, '')}`
  return null
}

const Row = ({ row, terms }: { row: SearchAllRow; terms: string[] }) => {
  const { Icon, tone } = KIND_META[row.kind]
  const href = hrefFor(row)

  const body = (
    // A bounded measure inside a full-width row: the hover and the rule
    // still span the page, but the title and its cost stay within one glance
    // instead of sitting a screen apart on a wide monitor.
    <div className="flex max-w-4xl min-w-0 items-start gap-2.5">
      <Icon size={13} className={cn('mt-[0.1875rem] shrink-0', tone)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-fg-subtle shrink-0 font-mono text-meta">{row.ref}</span>
          {row.project_key && row.kind !== 'knowledge' && (
            <span className="flex shrink-0 items-center gap-1">
              <ProjectIcon size={11} projectKey={row.project_key} />
            </span>
          )}
          <KindBadge kind={row.kind} />
          {row.answered && (
            <span className="text-status-done text-meta">
              {row.kind === 'task' ? 'answered' : row.kind === 'session' ? 'has next steps' : 'verified'}
            </span>
          )}
          {row.status === 'superseded' && (
            <span className="text-danger text-meta">superseded</span>
          )}
        </div>

        <p className="text-fg mt-1 text-ui leading-snug">
          <Highlight text={row.title} terms={terms} />
        </p>

        {row.subtitle && (
          <p className="text-fg-subtle mt-0.5 truncate text-meta">
            <Highlight text={row.subtitle} terms={terms} />
          </p>
        )}
      </div>

      {/* What opening it costs, in the same units `cairn check` prints. A
          bare "~19" read as a minus sign and a mystery number. */}
      {row.body_bytes > 0 && (
        <span
          className="text-fg-subtle shrink-0 self-center text-meta tabular-nums"
          title="Roughly how long it takes to read this in full"
        >
          {Math.max(1, Math.round(row.body_bytes / 1200))} min read
        </span>
      )}
    </div>
  )

  const className = 'border-border/70 block border-b px-4 py-2.5 last:border-0'

  return href ? (
    <Link href={href} className={cn(className, 'row-hover')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/**
 * Grouped by kind, in rank order within each group, and the groups in the
 * order of their best hit — so the top result is still the first thing on the
 * page, and a question answered by a fact is not buried under ten tasks that
 * merely mention it.
 */
export const UnifiedResults = ({ rows, query = '' }: { rows: SearchAllRow[]; query?: string }) => {
  const terms = queryTerms(query)
  // Rank order, not grouped by kind: the ranking already puts the best answer
  // first whatever it is, and grouping would bury a fact under ten tasks. The
  // badge on each row says what it is.
  return (
    <div className="stagger">
      {rows.map((row) => (
        <Row key={`${row.kind}:${row.id}`} row={row} terms={terms} />
      ))}
    </div>
  )
}
