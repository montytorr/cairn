import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import {
  currentUser, getTask, listAttachments, listComments, listNotes,
} from '@/lib/data'
import { MarkdownEditor } from '@/components/markdown-editor'
import { MarkdownView } from '@/components/markdown'
import { ProjectIcon } from '@/components/icons'
import { Properties } from './properties'
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

  const ref = task.external_ref ?? `${task.project.key}-${task.number}`

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-4">
        <Link href="/" className="text-fg-muted hover:text-fg text-[13px] transition-colors">
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <Link
          href={`/projects/${task.project.key}`}
          className="text-fg-muted hover:text-fg flex items-center gap-1.5 text-[13px] transition-colors"
        >
          <ProjectIcon size={13} />
          {task.project.title}
        </Link>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-fg-subtle text-[13px] tabular">{ref}</span>
        <span className="text-fg max-w-[38ch] truncate text-[13px]">{task.title}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-8 py-8">
            <h1 className="mb-6 text-[24px] leading-[1.25] font-semibold tracking-[-0.01em] text-balance">
              {task.title}
            </h1>

            {task.blocked_reason ? (
              <p className="text-danger bg-danger-subtle mb-5 rounded-md px-3 py-2 text-[12px]">
                Blocked: {task.blocked_reason}
              </p>
            ) : null}

            {/* Above the body on purpose: when a future agent opens a closed
                task, the answer is what it came for. */}
            {task.resolution ? (
              <div className="border-status-done/25 bg-status-done/[0.06] mb-6 rounded-md border py-2.5 pr-3 pl-3.5">
                <p className="text-status-done mb-1 text-[11px] font-medium">
                  Resolution{task.resolution_kind ? ` · ${task.resolution_kind}` : ''}
                  {task.resolved_by ? ` · ${task.resolved_by}` : ''}
                </p>
                <MarkdownView>{task.resolution}</MarkdownView>
              </div>
            ) : null}

            {task.checkpoint_summary && !task.resolution ? (
              <div className="border-border bg-surface-raised mb-6 rounded-md border py-2.5 pr-3 pl-3.5">
                <p className="text-fg-subtle mb-1 text-[11px] font-medium">Last checkpoint</p>
                <p className="text-fg-muted text-[13px]">{task.checkpoint_summary}</p>
              </div>
            ) : null}

            <div className="mb-10">
              <MarkdownEditor taskId={task.id} initial={task.description ?? ''} />
            </div>

            <div className="flex flex-col gap-10">
              <AttachmentsPanel taskId={task.id} attachments={attachments} />
              <NotesPanel taskId={task.id} notes={notes} />
              <CommentsPanel taskId={task.id} comments={comments} />
            </div>
          </div>
        </div>

        <div className="hidden overflow-y-auto lg:block">
          <Properties task={task} project={task.project} />
        </div>
      </div>
    </div>
  )
}

export default TaskPage
