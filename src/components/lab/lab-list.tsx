import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import { CATEGORY_LABEL, subjectHref, type Stage, type SubjectSummary } from './types'
import { ProjectLabel } from './project-label'
import { StageIcon } from './stage'
import { TagChip } from './tag-chip'
import { TodoTally } from './subject-card'

const Row = ({ subject }: { subject: SubjectSummary }) => (
  <li>
    <Link
      href={subjectHref(subject.number)}
      className="row-hover group flex min-h-[2.25rem] flex-col gap-1 px-3 py-2 md:flex-row md:items-center md:gap-x-3 md:py-1.5"
    >
      <span className="text-fg-subtle hidden w-[4.5rem] shrink-0 font-mono text-meta md:block">
        {subject.ref}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-fg block truncate text-ui font-medium">{subject.title}</span>
        {subject.conclusion ? (
          <span className="text-fg-muted block truncate text-meta">{subject.conclusion}</span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 md:contents">
        <span className="text-fg-subtle font-mono text-meta md:hidden">{subject.ref}</span>
        {subject.project ? (
          <span className="flex max-w-[9rem] shrink-0 items-center">
            <ProjectLabel project={subject.project} />
          </span>
        ) : null}
        {subject.tags.length > 0 ? (
          <span className="hidden max-w-[16rem] shrink items-center gap-1 overflow-hidden xl:flex">
            {subject.tags.slice(0, 3).map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </span>
        ) : null}
        <TodoTally todos={subject.todos} className="md:w-[4.5rem] md:justify-end" />
        <span
          className="flex shrink-0 items-center gap-1.5 md:w-[7rem]"
          title={subject.owner ? `Owner: ${subject.owner.name}` : 'No owner'}
        >
          {subject.owner ? (
            <>
              <Avatar name={subject.owner.name} size={16} />
              <span className="text-fg-muted truncate text-meta">{subject.owner.name}</span>
            </>
          ) : (
            <span className="text-fg-subtle text-meta">Unowned</span>
          )}
        </span>
        <RelativeTime iso={subject.updated_at} className="text-fg-subtle shrink-0 text-meta md:w-[4.5rem] md:text-right" />
      </span>
    </Link>
  </li>
)

/**
 * One section per stage, in pipeline order, each with its subjects beneath.
 * An empty stage still shows, as a line, so the list reads as the whole
 * pipeline and not only the parts that are busy.
 */
export const LabList = ({
  subjects,
  stages,
}: {
  subjects: SubjectSummary[]
  stages: Stage[]
}) => (
  <div className="pb-16">
    {stages.map((stage) => {
      const here = subjects.filter((s) => s.stage.id === stage.id)
      return (
        <section key={stage.id} aria-label={stage.name}>
          <h2
            className="group-band border-border sticky top-0 z-10 flex h-[2.125rem] items-center gap-2 border-b px-3"
            style={{ '--band': stage.color } as React.CSSProperties}
          >
            <StageIcon stage={stage} />
            <span className="text-fg text-meta font-medium">{stage.name}</span>
            <span className="text-fg-subtle tabular text-meta">{here.length}</span>
            <span className="text-fg-subtle ml-auto text-label tracking-[0.08em] uppercase">
              {CATEGORY_LABEL[stage.category]}
            </span>
          </h2>
          {here.length === 0 ? (
            <p className="text-fg-subtle px-3 py-2 text-meta">Nothing at this stage.</p>
          ) : (
            <ul className="divide-border stagger divide-y">
              {here.map((subject) => (
                <Row key={subject.id} subject={subject} />
              ))}
            </ul>
          )}
        </section>
      )
    })}
  </div>
)
