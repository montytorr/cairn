import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import {
  currentUser, getDuplicateOf, getParent, getTask, listActivity, listAlsoProjects,
  listAttachments, listProjects,
  listChildren, listComments, listNotes, listRelations,
} from '@/lib/data'
import { MarkdownEditor } from '@/components/markdown-editor'
import { MarkdownView } from '@/components/markdown'
import { ProjectIcon } from '@/components/icons'
import { Properties } from './properties'
import { EditableTitle } from './editable-title'
import { LiveUpdates } from '@/components/live-updates'
import { NotesPanel } from './notes-panel'
import { CommentsPanel } from './comments-panel'
import { AttachmentsPanel } from './attachments-panel'
import { ActivityPanel } from './activity-panel'
import { ChildrenPanel } from './children-panel'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

const TaskPage = async ({ params }: { params: Promise<{ key: string; number: string }> }) => {
  const { key, number } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const parsed = Number(number)
  if (!Number.isInteger(parsed)) notFound()

  const task = await getTask(user.id, key, parsed)
  if (!task) notFound()

  const [
    notes, comments, attachments, relations, duplicateOf, activity, children, parent,
    alsoProjects, allProjects,
  ] = await Promise.all([
    listNotes(task.id),
    listComments(task.id),
    listAttachments(task.id),
    listRelations(task.id),
    task.duplicate_of ? getDuplicateOf(task.duplicate_of) : Promise.resolve(null),
    listActivity(task.id),
    listChildren(task.id),
    task.parent_id ? getParent(task.parent_id) : Promise.resolve(null),
    listAlsoProjects(task.id),
    listProjects(user.id),
  ])

  const ref = task.external_ref ?? `${task.project.key}-${task.number}`

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[13px] transition-colors lg:block"
        >
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden lg:block" aria-hidden />
        <Link
          href={`/projects/${task.project.key}`}
          className="text-fg-muted hover:text-fg flex min-w-0 shrink items-center gap-1.5 text-[13px] transition-colors"
        >
          <ProjectIcon size={13} projectKey={task.project.key} />
          <span className="truncate">{task.project.title}</span>
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden shrink-0 sm:block" aria-hidden />
        {parent ? (
          <>
            <Link
              href={`/projects/${parent.ref.slice(0, parent.ref.lastIndexOf('-'))}/tasks/${parent.ref.slice(parent.ref.lastIndexOf('-') + 1)}`}
              prefetch
              className="text-fg-muted hover:text-fg hidden max-w-[22ch] truncate text-[13px] transition-colors sm:block"
              title={parent.title}
            >
              {parent.title}
            </Link>
            <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
          </>
        ) : null}
        <span className="text-fg-subtle shrink-0 text-[13px] tabular">{ref}</span>
        <span className="text-fg hidden max-w-[38ch] truncate text-[13px] sm:block">
          {task.title}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[820px] px-4 py-6 sm:px-6 lg:px-8">
            <EditableTitle taskId={task.id} initial={task.title} />

            {/* First thing on the page when it applies: a reader who opens a
                duplicate wants redirecting, not reading. */}
            {duplicateOf ? (
              <p className="border-border bg-surface-raised text-fg-muted mb-5 rounded-md border px-3 py-2 text-[12.5px]">
                Duplicate of{' '}
                <Link
                  href={`/projects/${duplicateOf.ref.slice(0, duplicateOf.ref.lastIndexOf('-'))}/tasks/${duplicateOf.ref.slice(duplicateOf.ref.lastIndexOf('-') + 1)}`}
                  prefetch
                  className="text-accent hover:underline"
                >
                  {duplicateOf.ref}
                </Link>{' '}
                — {duplicateOf.title}
              </p>
            ) : null}

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

            <div className="mb-6">
              <MarkdownEditor taskId={task.id} initial={task.description ?? ''} />
            </div>

            {/* Ruled rather than spaced. Five panels separated by 40px of air
                was most of the dead space on this page; a divider does the
                same job of separating them and reads as structure. Ordered by
                what a reader wants next: the split, then the evidence, then
                the conversation, then the audit trail. */}
            <div className="divide-border flex flex-col divide-y [&>*]:py-5">
              <ChildrenPanel
                taskRef={`${task.project.key}-${task.number}`}
                projectKey={task.project.key}
                items={children}
              />
              <AttachmentsPanel taskId={task.id} attachments={attachments} />
              <NotesPanel taskId={task.id} notes={notes} />
              <CommentsPanel taskId={task.id} comments={comments} />
              <ActivityPanel entries={activity} />
            </div>
          </div>
        </div>

        <div className="hidden overflow-y-auto lg:block">
          <Properties
            task={task}
            project={task.project}
            relations={relations}
            alsoProjects={alsoProjects}
            projects={allProjects.map((p) => ({ key: p.key, title: p.title }))}
          />
        </div>
      </div>
      <LiveUpdates projectKey={task.project.key} />
    </div>
  )
}

export default TaskPage
