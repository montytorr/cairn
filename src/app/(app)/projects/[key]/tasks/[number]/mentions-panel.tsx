import Link from 'next/link'
import { StatusIcon } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import { groupMentions, shortActor, type Mention } from '@/lib/api/mentions'
import type { TaskStatus } from '@/schemas/task'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

const taskHref = (ref: string) =>
  `/projects/${ref.slice(0, ref.lastIndexOf('-'))}/tasks/${ref.slice(ref.lastIndexOf('-') + 1)}`

/** The same colours the work log gives each kind, so a decision looks like one here too. */
const TONE: Record<string, string> = {
  decision: 'var(--accent)',
  finding: 'var(--status-in-review)',
  handoff: 'var(--status-doing)',
  resolution: 'var(--status-done)',
}

/**
 * Where other tasks named this one (CAIRN-267), decisions and findings first.
 * Absent when there are none: an empty "mentioned nowhere" section says
 * nothing a reader needs.
 *
 * One block per task that mentioned this one: its ref and title once, and a
 * line under it for each thing it said. Seven mentions across three audit
 * tasks used to be seven rows that each repeated a title the length of the
 * screen (CAIRN-362).
 */
export const MentionsPanel = ({ total, mentions }: { total: number; mentions: Mention[] }) => {
  if (mentions.length === 0) return null
  const groups = groupMentions(mentions)

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5')}>
        Mentioned in
        <span className={COUNT}>{total}</span>
        {total > mentions.length ? (
          <span className="font-normal tracking-normal normal-case">
            (the {mentions.length} that matter most)
          </span>
        ) : null}
      </h2>
      <ul className="flex flex-col gap-3">
        {groups.map((group) => (
          <li key={group.ref} className="min-w-0">
            <Link
              href={taskHref(group.ref)}
              prefetch
              className="row-hover -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-ui"
            >
              <StatusIcon status={group.status as TaskStatus} size={12} />
              <span className="text-accent tabular shrink-0">{group.ref}</span>
              <span className="text-fg min-w-0 truncate">{group.title}</span>
            </Link>
            <ul className="border-border mt-0.5 ml-[0.4375rem] flex flex-col gap-2 border-l pt-1 pl-3.5">
              {group.entries.map((m) => (
                <li key={`${m.source}-${m.at}-${m.kind ?? ''}`} className="min-w-0">
                  <div className="text-fg-subtle flex items-baseline gap-1.5 text-meta">
                    <span
                      className="font-medium"
                      style={{ color: TONE[m.kind ?? m.source] ?? 'var(--fg-muted)' }}
                    >
                      {m.kind ?? m.source}
                    </span>
                    {shortActor(m.by) ? <span>{shortActor(m.by)}</span> : null}
                    <RelativeTime iso={m.at} className="tabular" />
                  </div>
                  <p className="text-fg-muted line-clamp-2 text-ui">{m.excerpt}</p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
