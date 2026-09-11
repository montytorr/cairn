import { redirect } from 'next/navigation'
import { admin } from '@/lib/supabase/admin'
import { currentUser } from '@/lib/data'
import { PasswordSection } from './password-section'
import { KeysSection, type KeyRow } from './keys-section'
import { ArchivedSection, type ArchivedProject } from './archived-section'
import { LabelsSection, type LabelRow } from './labels-section'
import { EntitiesSection, type EntityRow } from './entities-section'
import { MobileNavButton } from '@/components/mobile-nav-context'

export const dynamic = 'force-dynamic'

const SettingsPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  // key_hash is never selected, here or anywhere.
  const { data } = await admin()
    .from('api_keys')
    .select('id, agent_name, name, key_prefix, last_used_at, revoked_at, created_at')
    .eq('user_id', user.id)
    .order('created_at')

  const { data: archived } = await admin()
    .from('projects')
    .select('id, key, title, task_counter')
    .eq('owner_user_id', user.id)
    .eq('status', 'archived')
    .order('title')

  const { data: labels } = await admin().rpc('list_labels', { p_owner: user.id })

  const [{ data: entityRows }, { data: projectRows }] = await Promise.all([
    admin()
      .from('entities')
      .select(
        'key, title, project_entities(project:projects(key)), knowledge_entities(knowledge_id)',
      )
      .eq('owner_user_id', user.id)
      .order('key'),
    admin()
      .from('projects')
      .select('key, title, project_entities(entity_id)')
      .eq('owner_user_id', user.id)
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
    <div className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-8 flex items-start gap-2">
        <span className="-ml-1.5 md:hidden">
          <MobileNavButton />
        </span>
        <div>
          <h1 className="font-display text-2xl leading-none">Settings</h1>
          <p className="text-fg-subtle mt-2 text-[12px]">{user.email}</p>
        </div>
      </header>

      <div className="flex flex-col gap-10">
        <PasswordSection />
        <KeysSection keys={(data ?? []) as KeyRow[]} />
        <LabelsSection labels={(labels ?? []) as LabelRow[]} />
        <EntitiesSection
          entities={entities}
          allProjects={allProjects}
          unassigned={unassigned}
        />
        <ArchivedSection projects={(archived ?? []) as ArchivedProject[]} />
      </div>
    </div>
  )
}

export default SettingsPage
