import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { parseProjectView } from '@/lib/project-view'
import { LiveUpdates } from '@/components/live-updates'
import { parseLabFilters } from '@/components/lab/filters'
import { LabView, LAB_VIEW_COOKIE } from '@/components/lab/lab-view'
import { getLabSettings, labSource, listLabProjects } from './data'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Lab' }

const LabPage = async ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')
  // Off, there is no Lab to find: the same answer as any address that is not.
  if (!(await getLabSettings()).enabled) notFound()

  const filters = parseLabFilters(await searchParams)
  const initialView = parseProjectView((await cookies()).get(LAB_VIEW_COOKIE)?.value)

  const [subjects, stages, tags, projects] = await Promise.all([
    labSource.subjects(user.id, filters),
    labSource.stages(),
    labSource.tags(),
    listLabProjects(user.id),
  ])

  return (
    <div className="flex h-dvh flex-col">
      {/* page-scroll-guard: fills the viewport on purpose. LabView owns the
          scrolling: the list scrolls as one, the board per lane. */}
      <div className="min-h-0 flex-1">
        <LabView
          subjects={subjects}
          stages={stages}
          tags={tags}
          projects={projects}
          initialView={initialView}
          filters={filters}
        />
      </div>
      {/* Unscoped: the Lab's changes are not any one project's. */}
      <LiveUpdates />
    </div>
  )
}

export default LabPage
