import { redirect } from 'next/navigation'
import { admin } from '@/lib/db/client'
import { currentUser } from '@/lib/data'
import { PasswordSection } from './password-section'
import { LabelsSection, type LabelRow } from './labels-section'
import { EntitiesSection, type EntityRow } from './entities-section'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

const SettingsPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const { data: labels } = await admin().rpc('list_labels', { p_owner: user.id })

  const [{ data: entityRows }, { data: projectRows }] = await Promise.all([
    admin()
      .from('entities')
      .select(
        'key, title, project_entities(project:projects(key)), knowledge_entities(knowledge_id)',
      )
      .order('key'),
    admin()
      .from('projects')
      .select('key, title, project_entities(entity_id)')
      .eq('status', 'active')
      .order('key'),
  ])

  const entities: EntityRow[] = (entityRows ?? []).map((e) => ({
    key: e.key as string,
    title: e.title as string,
    projects: (
      (e.project_entities ?? []) as unknown as {
        project: { key: string } | { key: string }[] | null
      }[]
    )
      .map((pe) => (Array.isArray(pe.project) ? pe.project[0]?.key : pe.project?.key))
      .filter((k): k is string => Boolean(k))
      .sort(),
    knowledgeCount: ((e.knowledge_entities as unknown[]) ?? []).length,
  }))

  const allProjects = (projectRows ?? []).map((p) => ({
    key: p.key as string,
    title: p.title as string,
  }))

  // Projects in no entity see only their own knowledge and whatever is global,
  // which is silent and easy to miss — so it is stated rather than left to be
  // discovered when a fact fails to show up.
  const unassigned = (projectRows ?? [])
    .filter((p) => ((p.project_entities as unknown[]) ?? []).length === 0)
    .map((p) => p.key as string)

  return (
    // The layout's <main> is overflow-hidden, so every page owns its own
    // scrolling. This one never did: it fitted the viewport until Entities was
    // added, and then simply clipped — no scrollbar, no overflow, the bottom of
    // the page just gone. The header bar is the one every other page has.
    <div className="flex h-dvh flex-col">
      <header className="border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg text-[0.8125rem] font-medium">Settings</span>
        <span className="text-fg-subtle hidden text-[0.8125rem] sm:block">·</span>
        <span className="text-fg-subtle hidden truncate text-[0.8125rem] sm:block">{user.email}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Centred at a form's measure, like vitals (e7e4f31). */}
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-10">
            <PasswordSection />
            <LabelsSection labels={(labels ?? []) as LabelRow[]} />
            <EntitiesSection
              entities={entities}
              allProjects={allProjects}
              unassigned={unassigned}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
