import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser, listProjects } from '@/lib/data'
import { searchTasks, type SearchRow } from '@/lib/api/search'
import { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from '@/schemas/task'
import { PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { SearchControls } from './search-controls'
import { SearchResults } from './search-results'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

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
          <SearchResults
            rows={rows.map((row) => ({
              id: row.id,
              number: row.number,
              title: row.title,
              type: row.type,
              status: row.status,
              priority: row.priority,
              resolution: row.resolution,
              resolution_kind: row.resolution_kind,
              description: row.description,
              project_key: row.project_key,
            }))}
          />
        )}
      </div>
    </div>
  )
}

export default SearchPage
