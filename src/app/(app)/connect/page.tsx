import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { loginRedirectTarget } from '@/lib/auth/login-redirect-server'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { ConnectCodeForm } from './connect-code-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Connect a device' }

/** The index a person lands on if they typed `/connect` rather than following a link with the code already in it. */
const ConnectIndexPage = async () => {
  const user = await currentUser()
  if (!user) redirect(await loginRedirectTarget())

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg text-ui font-medium">Connect a device</span>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10">
        <ConnectCodeForm />
      </div>
    </div>
  )
}

export default ConnectIndexPage
