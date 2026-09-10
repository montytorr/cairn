import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { searchTasks, type SearchRow } from '@/lib/api/search'
import { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from '@/schemas/task'
import { PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { SearchControls } from './search-controls'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'Fixed',
  'wont-fix': "Won't fix",
  duplicate: 'Duplicate',
  'not-reproducible': 'Not reproducible',
  superseded: 'Superseded',
  answered: 'Answered',
}

/** The one line that says whether an answer already exists. */
const Result = ({ row }: { row: SearchRow }) => {
  const ref = `${row.project_key}-${row.number}`
  return (
    <Link
      href={`/projects/${row.project_key}/tasks/${row.number}`}
      prefetch
      className="group hover:bg-surface-hover border-border block border-b px-4 py-2.5 transition-colors duration-75 last:border-0"
    >
      <div className="flex items-center gap-2">
        <PriorityIcon priority={row.priority as never} />
        <StatusIcon status={row.status as TaskStatus} />
        <span className="text-fg min-w-0 flex-1 truncate text-[13px]">{row.title}</span>
        <TypePill type={row.type as TaskType} />
        <ProjectIcon size={12} projectKey={row.project_key} />
        <code className="text-fg-subtle tabular w-[80px] shrink-0 truncate text-right text-[12px]">
          {ref}
        </code>
      </div>

      {/* A recorded resolution is the payload — show it here so the answer can
          be read without opening anything. */}
      {row.resolution ? (
        <p className="text-fg-muted mt-1.5 line-clamp-2 pl-[42px] text-[12.5px] leading-relaxed">
          <span className="text-status-done mr-1.5 text-[11px] font-medium">
            {RESOLUTION_LABEL[row.resolution_kind ?? ''] ?? 'Resolved'}
          </span>
          {row.resolution}
        </p>
      ) : row.description ? (
        <p className="text-fg-subtle mt-1 line-clamp-1 pl-[42px] text-[12.5px]">
          {row.description}
        </p>
      ) : null}
    </Link>
  )
}

const SearchPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; project?: string; type?: string; status?: string }>
}) => {
  const { q = '', project, type, status } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const projects = await listProjects(user.id)
  const query = q.trim()

  let rows: SearchRow[] = []
  let widened = false
  let failure: string | null = null

  if (query.length >= 2) {
    try {
      ;({ rows, widened } = await searchTasks(
        user.id,
        query,
        {
          project: project || undefined,
          type: TASK_TYPES.includes(type as TaskType) ? type : undefined,
          status: TASK_STATUSES.includes(status as TaskStatus) ? status : undefined,
        },
        60,
      ))
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Search failed.'
    }
  }

  const resolved = rows.filter((r) => r.resolution).length

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[44px] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[13px] transition-colors sm:block"
        >
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-[13px]">Search</span>
        {rows.length > 0 && (
          <span className="text-fg-subtle ml-auto hidden text-[12px] sm:block">
            {rows.length} {rows.length === 1 ? 'result' : 'results'}
            {resolved > 0 ? ` · ${resolved} with a recorded answer` : ''}
            {widened ? ' · loose match' : ''}
          </span>
        )}
      </header>

      <SearchControls
        q={q}
        project={project ?? ''}
        type={type ?? ''}
        status={status ?? ''}
        projects={projects.map((p) => ({ key: p.key, title: p.title }))}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure ? (
          <p className="text-danger px-4 py-8 text-[13px]">{failure}</p>
        ) : query.length < 2 ? (
          <div className="text-fg-subtle px-4 py-12 text-center text-[13px]">
            <p>Search every task, comment, note and resolution.</p>
            <p className="mt-1.5 text-[12px]">
              Closed work is included on purpose — a recorded answer is the point.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-fg-subtle px-4 py-12 text-center text-[13px]">
            <p>
              Nothing found for <span className="text-fg-muted">{query}</span>.
            </p>
            <p className="mt-1.5 text-[12px]">This subject looks new.</p>
          </div>
        ) : (
          <div>
            {rows.map((row) => (
              <Result key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default SearchPage
