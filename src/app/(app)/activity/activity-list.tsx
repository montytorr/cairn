import Link from 'next/link'
import { BookMarked, FileText, ListTodo, MessageSquare, Radio, Shuffle } from 'lucide-react'
import { Avatar, ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { ActivityRow } from '@/lib/api/activity-feed'

const KIND: Record<ActivityRow['kind'], { label: string; Icon: typeof ListTodo; tone: string }> = {
  task: { label: 'filed', Icon: ListTodo, tone: 'text-accent' },
  event: { label: 'changed', Icon: Shuffle, tone: 'text-fg-subtle' },
  note: { label: 'note', Icon: FileText, tone: 'text-fg-muted' },
  comment: { label: 'comment', Icon: MessageSquare, tone: 'text-fg-muted' },
  session: { label: 'session', Icon: Radio, tone: 'text-fg-subtle' },
  knowledge: { label: 'knowledge', Icon: BookMarked, tone: 'text-status-done' },
}

/** Where a row leads. A session has no page of its own, and its useful content
 *  is the line already shown, so it stays unlinked rather than pointing at a
 *  list the reader is already looking at. */
const hrefFor = (row: ActivityRow): string | null => {
  if (row.kind === 'knowledge') return `/knowledge/${row.ref}`
  if (row.kind === 'session') return null
  const [key, number] = row.ref.split('-')
  return key && number ? `/projects/${key}/tasks/${number}` : null
}

const Row = ({ row }: { row: ActivityRow }) => {
  const { label, Icon, tone } = KIND[row.kind]
  const href = hrefFor(row)
  const time = row.at.slice(11, 16)

  const body = (
    <div className="flex min-w-0 items-start gap-2.5 px-4 py-2">
      <span className="text-fg-subtle w-[38px] shrink-0 pt-[2px] text-[11px] tabular-nums">
        {time}
      </span>
      <Icon size={13} className={cn('mt-[3px] shrink-0', tone)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {row.actor && <Avatar name={row.actor} size={14} />}
          <span className="text-fg-subtle text-[11px]">{label}</span>
          {row.detail && row.detail !== label && (
            <span className="text-fg-subtle text-[11px]">· {row.detail.replace(/_/g, ' ')}</span>
          )}
          {row.project_key && (
            <span className="flex shrink-0 items-center gap-1">
              <ProjectIcon size={10} projectKey={row.project_key.split(',')[0]} />
              <span className="text-fg-subtle font-mono text-[11px]">{row.ref}</span>
            </span>
          )}
        </div>
        <p className="text-fg mt-0.5 line-clamp-2 text-[13px] leading-snug">{row.title}</p>
      </div>
    </div>
  )

  return href ? (
    <Link href={href} className="hover:bg-surface-hover block transition-colors">
      {body}
    </Link>
  ) : (
    <div>{body}</div>
  )
}

export const ActivityList = ({ rows }: { rows: ActivityRow[] }) => {
  const days = new Map<string, ActivityRow[]>()
  for (const row of rows) {
    const day = row.at.slice(0, 10)
    days.set(day, [...(days.get(day) ?? []), row])
  }

  return (
    <div>
      {[...days].map(([day, items]) => (
        <section key={day}>
          <h2 className="border-border bg-surface text-fg-muted sticky top-0 z-10 border-y px-4 py-1.5 text-[12px]">
            {new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'Europe/Paris',
            })}
          </h2>
          <div className="divide-border divide-y">
            {items.map((row, i) => (
              <Row key={`${row.kind}:${row.ref}:${row.at}:${i}`} row={row} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
