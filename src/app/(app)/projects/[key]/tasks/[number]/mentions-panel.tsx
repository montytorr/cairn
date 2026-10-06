import Link from 'next/link'
import { StatusIcon } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import type { Mention } from '@/lib/api/mentions'
import type { TaskStatus } from '@/schemas/task'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

const taskHref = (ref: string) =>
  `/projects/${ref.slice(0, ref.lastIndexOf('-'))}/tasks/${ref.slice(ref.lastIndexOf('-') + 1)}`

/**
 * Where other tasks named this one (CAIRN-267), decisions and findings first.
 * Absent when there are none: an empty "mentioned nowhere" section says
 * nothing a reader needs.
 */
export const MentionsPanel = ({ total, mentions }: { total: number; mentions: Mention[] }) => {
  if (mentions.length === 0) return null

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5')}>
        Mentioned in
        <span className={COUNT}>{total}</span>
        {total > mentions.length ? (
          <span className="font-normal tracking-normal normal-case">
            (the {mentions.length} that matter most)
          </span>
        ) : null}
      </h2>
      <ul className="flex flex-col gap-1">
        {mentions.map((m) => (
          <li
            key={`${m.ref}-${m.source}-${m.at}`}
            className="row-hover -mx-2 rounded-md px-2 py-1 text-ui"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <StatusIcon status={m.status as TaskStatus} size={12} />
              <Link
                href={taskHref(m.ref)}
                prefetch
                className="text-accent tabular decoration-accent/50 underline-offset-[3px] hover:underline"
              >
                {m.ref}
              </Link>
              <span className="text-fg min-w-0 truncate">{m.title}</span>
              <span className="text-fg-subtle text-meta">
                {m.kind ?? m.source}
                {m.by ? ` · ${m.by}` : ''} · <RelativeTime iso={m.at} />
              </span>
            </div>
            <p className="text-fg-muted border-border mt-1 border-l-2 pl-2.5">{m.excerpt}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
