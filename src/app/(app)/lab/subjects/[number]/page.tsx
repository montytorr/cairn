import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser } from '@/lib/data'
import { BrandName } from '@/components/brand'
import { Avatar } from '@/components/icons'
import { LiveUpdates } from '@/components/live-updates'
import { MarkdownView } from '@/components/markdown'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { RelativeTime } from '@/components/relative-time'
import { FilesPanel } from '@/components/lab/files-panel'
import { HumanNotesPanel } from '@/components/lab/human-notes-panel'
import { LogPanel } from '@/components/lab/log-panel'
import { ProjectLabel } from '@/components/lab/project-label'
import { StageBadge } from '@/components/lab/stage'
import { SubjectProperties } from '@/components/lab/subject-properties'
import { SubjectTitle } from '@/components/lab/subject-title'
import { isSubjectTab } from '@/components/lab/subject-tabs'
import { SubjectWorkspace } from '@/components/lab/subject-workspace'
import { SubjectWriteUp } from '@/components/lab/subject-writeup'
import { TagChip } from '@/components/lab/tag-chip'
import { TodosPanel } from '@/components/lab/todos-panel'
import { tally } from '@/components/lab/todo-lanes'
import { parseSubjectRef } from '@/components/lab/types'
import { getLabSettings, labSource, listLabProjects } from '../../data'

export const dynamic = 'force-dynamic'

// Deduped against the page's own lookup (React cache(), same request).
const cachedSubject = cache((number: number) => labSource.subject(number))

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ number: string }>
}): Promise<Metadata> => {
  const n = parseSubjectRef((await params).number)
  if (n === null) return { title: 'Subject' }
  const user = await currentUser()
  if (!user || !(await getLabSettings()).enabled) return { title: `LAB-${n}` }
  const subject = await cachedSubject(n)
  const title = subject ? `${subject.ref} · ${subject.title}` : `LAB-${n}`
  return { title: title.length > 60 ? `${title.slice(0, 59)}…` : title }
}

/**
 * A subject across the whole width: its title and where it stands, then its
 * sections (write-up, todos, people's notes, log, files) as tabs over one
 * working area, with its properties in a rail. `LAB-12` and `12` both resolve;
 * `?tab=todos&view=board` opens a section.
 */
const SubjectPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>
  searchParams: Promise<{ tab?: string; view?: string }>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!(await getLabSettings()).enabled) notFound()

  const n = parseSubjectRef((await params).number)
  if (n === null) notFound()
  const subject = await cachedSubject(n)
  if (!subject) notFound()
  const query = await searchParams

  const [log, todos, humanNotes, files, stages, tags, projects] = await Promise.all([
    labSource.notes(subject),
    labSource.todos(subject),
    labSource.humanNotes(subject),
    labSource.attachments(subject),
    labSource.stages(),
    labSource.tags(),
    listLabProjects(user.id),
  ])

  const counts = tally(todos)
  const isAdmin = user.role === 'admin'

  return (
    // page-scroll-guard: fills the viewport on purpose. SubjectWorkspace owns
    // the scrolling: the page as one on a phone, the column and rail apart
    // from `lg`.
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg hidden text-ui transition-colors lg:block">
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden lg:block" aria-hidden />
        <Link href="/lab" className="text-fg-muted hover:text-fg text-ui transition-colors">
          Lab
        </Link>
        <ChevronRight size={13} className="text-fg-subtle shrink-0" aria-hidden />
        <span className="text-fg-subtle shrink-0 text-ui tabular">{subject.ref}</span>
        <span className="text-fg hidden max-w-[38ch] truncate text-ui sm:block">{subject.title}</span>
        {subject.archived_at ? (
          <span className="border-border text-fg-subtle ml-1 shrink-0 rounded border px-1.5 py-px text-label uppercase tracking-wide">
            Archived
          </span>
        ) : null}
      </header>

      <SubjectWorkspace
        initialTab={isSubjectTab(query.tab) ? query.tab : 'writeup'}
        counts={{
          todos: counts.open,
          notes: humanNotes.length,
          log: log.length,
          files: files.length,
        }}
        header={
          <>
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span className="border-border bg-surface-raised text-fg-muted inline-flex h-[1.25rem] shrink-0 items-center rounded-md border px-1.5 font-mono text-meta">
                {subject.ref}
              </span>
              <StageBadge stage={subject.stage} className="text-fg-muted text-ui" />
              {subject.project ? <ProjectLabel project={subject.project} /> : null}
              {subject.owner ? (
                <span className="text-fg-muted flex items-center gap-1.5 text-meta">
                  <Avatar name={subject.owner.name} size={16} />
                  {subject.owner.name}
                </span>
              ) : null}
              <span className="text-fg-subtle text-meta">
                Updated <RelativeTime iso={subject.updated_at} />
              </span>
            </div>

            <SubjectTitle subjectRef={subject.ref} initial={subject.title} />

            {subject.tags.length > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                {subject.tags.map((tag) => (
                  <TagChip key={tag.id} tag={tag} />
                ))}
              </div>
            ) : null}

            {subject.conclusion ? (
              // The rail carries the conclusion from `lg`; this is the phone's.
              <div className="surface-card relative mb-2 overflow-hidden py-2 pr-3 pl-3.5 lg:hidden">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[2px]"
                  style={{ backgroundColor: subject.stage.color }}
                />
                <p className="text-fg-subtle mb-1 text-label font-medium tracking-[0.08em] uppercase">
                  Conclusion
                </p>
                <MarkdownView>{subject.conclusion}</MarkdownView>
              </div>
            ) : null}
          </>
        }
        panels={{
          writeup: <SubjectWriteUp subjectRef={subject.ref} body={subject.body} />,
          todos: (
            <TodosPanel
              subjectRef={subject.ref}
              todos={todos}
              initialView={query.view === 'board' ? 'board' : 'list'}
            />
          ),
          notes: <HumanNotesPanel subjectRef={subject.ref} notes={humanNotes} isAdmin={isAdmin} />,
          log: <LogPanel subjectRef={subject.ref} notes={log} />,
          files: <FilesPanel subjectRef={subject.ref} files={files} />,
        }}
        rail={
          <SubjectProperties
            subject={subject}
            stages={stages}
            tags={tags}
            projects={projects}
            isAdmin={isAdmin}
          />
        }
      />
      {/* Unscoped, like the Lab itself. */}
      <LiveUpdates />
    </div>
  )
}

export default SubjectPage
