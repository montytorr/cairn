import { redirect } from 'next/navigation'
import { admin } from '@/lib/supabase/admin'
import { currentUser } from '@/lib/data'
import { PasswordSection } from './password-section'
import { KeysSection, type KeyRow } from './keys-section'
import { ArchivedSection, type ArchivedProject } from './archived-section'
import { LabelsSection, type LabelRow } from './labels-section'
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
        <ArchivedSection projects={(archived ?? []) as ArchivedProject[]} />
      </div>
    </div>
  )
}

export default SettingsPage
