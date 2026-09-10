import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import {
  currentUser, getTask, listAttachments, listComments, listNotes,
} from '@/lib/data'
import { MarkdownEditor } from '@/components/markdown-editor'
import { MarkdownView } from '@/components/markdown'
import { ClaimChip, StatusBadge, TypeBadge } from '@/components/badges'
import { isClaimStale } from '@/lib/utils'
import { TaskMeta } from './task-meta'
import { NotesPanel } from './notes-panel'
import { CommentsPanel } from './comments-panel'
import { AttachmentsPanel } from './attachments-panel'

export const dynamic = 'force-dynamic'

const TaskPage = async ({ params }: { params: Promise<{ key: string; number: string }> }) => {
  const { key, number } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const parsed = Number(number)
  if (!Number.isInteger(parsed)) notFound()

  const task = await getTask(user.id, key, parsed)
  if (!task) notFound()

  const [notes, comments, attachments] = await Promise.all([
    listNotes(task.id),
    listComments(task.id),
    listAttachments(task.id),
  ])

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <Link
        href={`/projects/${task.project.key}`}
        className="text-fg-subtle hover:text-fg mb-4 inline-flex items-center gap-1 text-xs"
      >
        <ChevronLeft size={13} />
        {task.project.title}
      </Link>

      <div className="grid gap-8 md:grid-cols-[1fr_15rem]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2.5">
            <code className="text-fg-subtle text-xs">
              {task.project.key}-{task.number}
            </code>
            <TypeBadge type={task.type} />
            <StatusBadge status={task.status} />
            {task.claimed_by && (
              <ClaimChip by={task.claimed_by} stale={isClaimStale(task.heartbeat_at)} />
            )}
          </div>

          <h1 className="mb-5 text-xl leading-tight font-semibold tracking-tight">{task.title}</h1>

          {task.blocked_reason ? (
            <p className="text-danger bg-danger-subtle mb-4 rounded-md px-3 py-2 text-xs">
              Blocked: {task.blocked_reason}
            </p>
          ) : null}

          {/* The resolution sits above the body: when a future agent opens a
              closed task, the answer is the thing it came for. */}
          {task.resolution ? (
            <div className="border-status-done/40 bg-status-done/5 mb-5 rounded-md border p-3">
              <p className="text-status-done mb-1 text-[11px] font-medium tracking-wide uppercase">
                Resolution{task.resolution_kind ? ` · ${task.resolution_kind}` : ''}
                {task.resolved_by ? ` · ${task.resolved_by}` : ''}
              </p>
              <MarkdownView>{task.resolution}</MarkdownView>
            </div>
          ) : null}

          {task.checkpoint_summary && !task.resolution ? (
            <div className="border-border bg-surface-raised mb-5 rounded-md border p-3">
              <p className="text-fg-subtle mb-1 text-[11px] font-medium tracking-wide uppercase">
                Last checkpoint
                {task.checkpoint_at ? ` · ${task.checkpoint_at.slice(0, 16).replace('T', ' ')}` : ''}
              </p>
              <p className="text-fg-muted text-[13px]">{task.checkpoint_summary}</p>
            </div>
          ) : null}

          <div className="mb-8">
            <MarkdownEditor taskId={task.id} initial={task.description ?? ''} />
          </div>

          <div className="flex flex-col gap-8">
            <NotesPanel taskId={task.id} notes={notes} />
            <CommentsPanel taskId={task.id} comments={comments} />
          </div>
        </div>

        <aside className="flex flex-col gap-6">
          <TaskMeta task={task} />
          <AttachmentsPanel taskId={task.id} attachments={attachments} />
          {task.attempt > 1 && (
            <p className="text-fg-subtle text-[11px] leading-relaxed">
              Claimed {task.attempt} times — this task may be thrashing.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}

export default TaskPage
