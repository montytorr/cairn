import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { currentUser } from '@/lib/data'
import { listOwnKeys } from '@/lib/api/own-keys'
import { OwnKeysManager } from './own-keys-manager'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your agent keys' }

/**
 * Self-service keys (CAIRN-315). CAIRN-172 removed a keys section from
 * /settings because it duplicated /users for administrators and let them mint
 * keys through a second endpoint. This is not that: it creates nothing — new
 * keys arrive only through `cairn setup` pairing — and it shows only the
 * signed-in person's own keys, so a member who retires or loses a machine can
 * cut it off without waiting for an administrator.
 */
const OwnKeysPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const keys = await listOwnKeys(user.id)

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/settings"
          className="text-fg-subtle hover:text-fg text-[0.8125rem] transition-colors duration-[var(--dur-1)]"
        >
          Settings
        </Link>
        <span className="text-fg-subtle text-[0.8125rem]">/</span>
        <span className="text-fg text-[0.8125rem] font-medium">Your agent keys</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
          <p className="text-fg-subtle mb-5 text-[0.75rem] leading-relaxed">
            New keys arrive when you run <code>cairn setup</code> on a machine and approve it — each is
            named for its runtime and host. Revoke a machine&apos;s keys when you retire or lose it: they stop
            working on their next request.
          </p>
          <OwnKeysManager keys={keys} />
        </div>
      </div>
    </div>
  )
}

export default OwnKeysPage
