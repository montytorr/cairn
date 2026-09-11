import Link from 'next/link'
import { BookMarked, FileText, ListTodo, Radio } from 'lucide-react'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { SearchAllRow } from '@/lib/api/search'

/**
 * Results across all four stores.
 *
 * The task-only list next door stays as it is because it carries selection and
 * bulk edit, which only mean anything for tasks. This renders the rest in rank
 * order without pretending a session can be bulk-assigned a priority.
 */

const KIND_META: Record<
  SearchAllRow['kind'],
  { label: string; Icon: typeof ListTodo; tone: string }
> = {
  task: { label: 'Task', Icon: ListTodo, tone: 'text-accent' },
  note: { label: 'Note', Icon: FileText, tone: 'text-fg-muted' },
  knowledge: { label: 'Knowledge', Icon: BookMarked, tone: 'text-status-done' },
  session: { label: 'Session', Icon: Radio, tone: 'text-fg-subtle' },
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
  return null
}

const Row = ({ row }: { row: SearchAllRow }) => {
  const { label, Icon, tone } = KIND_META[row.kind]
  const href = hrefFor(row)

  const body = (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon size={13} className={cn('mt-[3px] shrink-0', tone)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-fg-subtle shrink-0 font-mono text-[11px]">{row.ref}</span>
          {row.project_key && row.kind !== 'knowledge' && (
            <span className="flex shrink-0 items-center gap-1">
              <ProjectIcon size={11} projectKey={row.project_key} />
            </span>
          )}
          <span className="text-fg-subtle text-[11px]">{label}</span>
          {row.answered && (
            <span className="text-status-done text-[11px]">
              {row.kind === 'task' ? 'answered' : row.kind === 'session' ? 'has next steps' : 'verified'}
            </span>
          )}
          {row.status === 'superseded' && (
            <span className="text-danger text-[11px]">superseded</span>
          )}
        </div>

        <p className="text-fg mt-1 text-[13px] leading-snug">{row.title}</p>

        {row.subtitle && (
          <p className="text-fg-subtle mt-0.5 truncate text-[11px]">{row.subtitle}</p>
        )}
      </div>

      <span className="text-fg-subtle shrink-0 self-center text-[11px] tabular-nums">
        ~{Math.ceil(row.body_bytes / 4)}
      </span>
    </div>
  )

  const className = 'border-border block border-b px-4 py-2.5'

  return href ? (
    <Link href={href} className={cn(className, 'hover:bg-surface-hover transition-colors')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

export const UnifiedResults = ({ rows }: { rows: SearchAllRow[] }) => (
  <div>
    {rows.map((row) => (
      <Row key={`${row.kind}:${row.id}`} row={row} />
    ))}
  </div>
)
