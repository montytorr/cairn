import type { Metadata } from 'next'
import { cache } from 'react'
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
import { ProjectIcon, StatusIcon } from '@/components/icons'
import { BrandName } from '@/components/brand'
import { RelativeTime } from '@/components/relative-time'
import { isTerminal } from '@/schemas/task'
import { cn } from '@/lib/utils'
import { Properties } from './properties'
import { EditableTitle } from './editable-title'
import { LiveUpdates } from '@/components/live-updates'
import { NotesPanel } from './notes-panel'
import { CommentsPanel } from './comments-panel'
import { AttachmentsPanel } from './attachments-panel'
import { ActivityPanel } from './activity-panel'
import { ChildrenPanel } from './children-panel'
import { MentionsPanel } from './mentions-panel'
import { mentionsOf } from '@/lib/api/mentions'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { RedirectNotice } from '@/components/redirect-notice'
import { listFormerKeyRecords } from '@/lib/data'
import { formerRefsOf, renameLine, renamesOf, taskRedirectNotice } from '@/lib/project-rename'
import { LABEL, PANE } from './styles'

export const dynamic = 'force-dynamic'

// Deduped against the page's own lookup below (React cache(), same request).
const cachedTask = cache(getTask)

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ key: string; number: string }>
}): Promise<Metadata> => {
  const { key, number } = await params
  const parsed = Number(number)
  const ref = `${key.toUpperCase()}-${number}`
  if (!Number.isInteger(parsed)) return { title: ref }
  // Signed in or no title: the layout turns everyone else away, but metadata
  // is resolved alongside it, not after it.
  const user = await currentUser()
  if (!user) return { title: ref }
  const task = await cachedTask(user.id, key, parsed)
  if (!task) return { title: ref }
  const title = `${ref} · ${task.title}`
  return { title: title.length > 60 ? `${title.slice(0, 59)}…` : title }
}

/**
 * A note set above the body: a flat panel with a solid stripe down its left
 * edge in the note's own colour, so a blocked task, a duplicate and an answer
 * are told apart before a word is read.
 */
const Callout = ({
  tone,
  className,
  children,
}: {
  tone: string
  className?: string
  children: React.ReactNode
}) => (
  <div className={cn('surface-card relative mb-5 overflow-hidden py-2 pr-3 pl-3.5', className)}>
    <span aria-hidden className="absolute inset-y-0 left-0 w-[2px]" style={{ backgroundColor: tone }} />
    {children}
  </div>
)

const Dot = () => (
  <span aria-hidden className="text-fg-subtle">
    ·
  </span>
)

const TaskPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ key: string; number: string }>
  searchParams: Promise<{ from?: string }>
}) => {
  const { key, number } = await params
  const { from } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const parsed = Number(number)
  if (!Number.isInteger(parsed)) notFound()

  const [task, formerKeys] = await Promise.all([
    cachedTask(user.id, key, parsed),
    listFormerKeyRecords(),
  ])

  // The key may be one this project used to have. Refs escape into commit
  // messages and PR titles, which a rename cannot reach, so an old link lands
  // on the task and the address bar corrects itself to the live ref — saying
  // so on arrival, through `from`, because a silent swap of AC-113 for
  // HOL-113 leaves the reader unsure they found the same task.
  if (!task) {
    const retired = formerKeys.find((row) => row.key === key.toUpperCase() && row.current)
    if (retired) {
      const was = `${retired.key}-${parsed}`
      redirect(`/projects/${retired.current}/tasks/${parsed}?from=${encodeURIComponent(was)}`)
    }
    notFound()
  }

  const [
    notes, comments, attachments, relations, duplicateOf, activity, children, parent,
    alsoProjects, allProjects, mentioned,
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
    mentionsOf(task.id, 8),
  ])

  // What this task used to be called. An alias that only resolves is half an
  // answer: the lookup would succeed and the screen would show CAI-42, so a
  // reader holding ACME-42 from a commit message still could not tell they had
  // found the right task. Showing both is what lets them connect it by eye.
  // Only keys retired after the task was filed: HOL-114 postdates AC, and a
  // label saying it "was AC-114" names a ref that never existed.
  const renames = renamesOf(
    formerKeys.filter((row) => row.project_id === task.project.id),
    task.project.key,
  )
  const formerRefs = formerRefsOf(renames, task)

  // The Cairn ref, never the imported one. Preferring external_ref showed a
  // migrated task as LEGACY-1234 — an identifier that resolves nowhere in this
  // system, on the page whose whole job is to tell you what you are looking at.
  const ref = `${task.project.key}-${task.number}`
  const arrivedFrom = taskRedirectNotice(from, renames, { ...task, ref })

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[0.8125rem] transition-colors lg:block"
        >
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden lg:block" aria-hidden />
        <Link
          href={`/projects/${task.project.key}`}
          className="text-fg-muted hover:text-fg flex min-w-0 shrink items-center gap-1.5 text-[0.8125rem] transition-colors"
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
              className="text-fg-muted hover:text-fg hidden max-w-[22ch] truncate text-[0.8125rem] transition-colors sm:block"
              title={parent.title}
            >
              {parent.title}
            </Link>
            <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
          </>
        ) : null}
        <span className="text-fg-subtle shrink-0 text-[0.8125rem] tabular">{ref}</span>
        {/* Where it came from, kept visible rather than substituted for the
            ref: matching a task against the Linear export is a real need, and
            it is the only place that identifier now appears. */}
        {task.external_ref ? (
          <span
            className="text-fg-subtle hidden shrink-0 text-[0.6875rem] tabular sm:inline"
            title={`External ref ${task.external_ref}`}
          >
            ({task.external_ref})
          </span>
        ) : null}
        {/* Beside the imported ref, not instead of it — a project imported
            from Linear and later renamed has both, and they answer different
            questions. Shown on a phone too: an old ref arriving from a commit
            message is no less confusing on a small screen. */}
        {formerRefs.length > 0 ? (
          <span
            className="text-fg-subtle min-w-0 shrink truncate text-[0.6875rem] tabular"
            title={formerRefs
              .map(({ ref: was, rename }) => `Was ${was} · ${renameLine(rename)}. ${was} still resolves here.`)
              .join('\n')}
          >
            (was {formerRefs.map((r) => r.ref).join(', ')})
            <span className="sr-only">
              {' — '}
              {formerRefs.map((r) => renameLine(r.rename)).join('; ')}
            </span>
          </span>
        ) : null}
        <span className="text-fg hidden max-w-[38ch] truncate text-[0.8125rem] sm:block">
          {task.title}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[51.25rem] px-4 py-6 sm:px-6 lg:px-8">
            {/* The ref and the project, quiet above the title rather than
                competing with it: the title is the page's one voice. */}
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="border-border bg-surface-raised text-fg-muted inline-flex h-[1.25rem] shrink-0 items-center rounded-md border px-1.5 font-mono text-[0.6875rem]">
                {ref}
              </span>
              <Link
                href={`/projects/${task.project.key}`}
                className="border-border text-fg-muted hover:text-fg hover:border-border-strong hover:bg-surface-hover inline-flex h-[1.25rem] min-w-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-[0.6875rem] transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]"
              >
                <ProjectIcon size={11} projectKey={task.project.key} />
                <span className="truncate">{task.project.title}</span>
              </Link>
            </div>

            <EditableTitle taskId={task.id} initial={task.title} />

            <RedirectNotice message={arrivedFrom} />

            {/* First thing on the page when it applies: a reader who opens a
                duplicate wants redirecting, not reading. */}
            {duplicateOf ? (
              <Callout tone="var(--fg-subtle)">
                <p className="text-fg-muted text-[0.78125rem]">
                  Duplicate of{' '}
                  <Link
                    href={`/projects/${duplicateOf.ref.slice(0, duplicateOf.ref.lastIndexOf('-'))}/tasks/${duplicateOf.ref.slice(duplicateOf.ref.lastIndexOf('-') + 1)}`}
                    prefetch
                    className="text-accent decoration-accent/50 underline-offset-[3px] hover:underline"
                  >
                    {duplicateOf.ref}
                  </Link>{' '}
                  — {duplicateOf.title}
                </p>
              </Callout>
            ) : null}

            {task.blocked_reason ? (
              <Callout tone="var(--danger)">
                <p className="text-danger text-[0.75rem]">Blocked: {task.blocked_reason}</p>
              </Callout>
            ) : null}

            {/* Above the body on purpose: when a future agent opens a closed
                task, the answer is what it came for — so it is the one card on
                the page edged in its status's colour. */}
            {task.resolution ? (
              <Callout tone={`var(--status-${task.status})`} className="mb-6 py-3 pr-4 pl-[1.125rem]">
                <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem]">
                  <StatusIcon status={task.status} size={12} />
                  <span className="font-medium" style={{ color: `var(--status-${task.status})` }}>
                    {isTerminal(task.status) ? 'Resolved' : 'Resolution'}
                  </span>
                  {task.resolution_kind ? (
                    <>
                      <Dot />
                      <span className="text-fg-muted">{task.resolution_kind}</span>
                    </>
                  ) : null}
                  {task.resolved_by ? (
                    <>
                      <Dot />
                      <span className="text-fg-muted">{task.resolved_by}</span>
                    </>
                  ) : null}
                  {task.resolved_at ? (
                    <>
                      <Dot />
                      <RelativeTime iso={task.resolved_at} className="text-fg-subtle" />
                    </>
                  ) : null}
                </p>
                <MarkdownView>{task.resolution}</MarkdownView>
              </Callout>
            ) : null}

            {task.checkpoint_summary && !task.resolution ? (
              <Callout tone="var(--fg-subtle)" className="mb-6 py-2.5">
                <p className={cn(LABEL, 'mb-1')}>Last checkpoint</p>
                <p className="text-fg-muted text-[0.8125rem]">{task.checkpoint_summary}</p>
              </Callout>
            ) : null}

            <div className="mb-6">
              <MarkdownEditor taskId={task.id} initial={task.description ?? ''} />
            </div>

            {/* Ruled rather than spaced. Five panels separated by 40px of air
                was most of the dead space on this page; a divider does the
                same job of separating them and reads as structure. Ordered by
                what a reader wants next: the split, then the evidence, then
                the conversation, then the audit trail. */}
            <div className="[&>*+*]:border-border flex flex-col [&>*]:py-5 [&>*+*]:border-t">
              <MentionsPanel total={mentioned.total} mentions={mentioned.mentions} />
              <ChildrenPanel
                taskRef={`${task.project.key}-${task.number}`}
                projectKey={task.project.key}
                items={children}
                projects={allProjects.map((p) => ({ key: p.key, title: p.title }))}
              />
              <AttachmentsPanel taskId={task.id} attachments={attachments} />
              <NotesPanel taskId={task.id} notes={notes} />
              <CommentsPanel taskId={task.id} comments={comments} />
              <ActivityPanel entries={activity} />
            </div>
          </div>
        </div>

        {/* Fixed width AND `overflow-x-hidden` set here, not left to the
            column inside: `overflow-y-auto` alone computes `overflow-x` as
            `auto` too (CSS's rule for a lone non-`visible` axis), so any
            child that refused to shrink turned this pane into a horizontal
            scroller — pinning both here forecloses that regardless of what
            the column renders. */}
        <div
          className={cn(
            PANE,
            'hidden w-[18rem] shrink-0 overflow-x-hidden overflow-y-auto lg:block',
          )}
        >
          <Properties
            task={task}
            project={task.project}
            relations={relations}
            alsoProjects={alsoProjects}
            projects={allProjects.map((p) => ({ key: p.key, title: p.title }))}
            parent={parent}
          />
        </div>
      </div>
      <LiveUpdates projectKey={task.project.key} />
    </div>
  )
}

export default TaskPage
