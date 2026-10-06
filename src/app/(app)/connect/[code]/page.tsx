import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { headers } from 'next/headers'
import { clientAddress } from '@/lib/api/client-address'
import { findConnectRequestByUserCode, normalizeUserCode, PRIVILEGED_RUNTIMES } from '@/lib/api/connect'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { ConnectApproval, type ConnectView } from './connect-approval'
import { loginRedirectTarget } from '@/lib/auth/login-redirect-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Connect a device' }

/**
 * Approving mints keys for the signed-in person's own agents, so this lives
 * under the (app) group deliberately — the middleware and layout already
 * redirect a signed-out visitor to `/login?redirect=/connect/<code>` and
 * bring them straight back here once they are in, for free.
 */
const ConnectPage = async ({ params }: { params: Promise<{ code: string }> }) => {
  const user = await currentUser()
  if (!user) redirect(await loginRedirectTarget())

  const { code } = await params
  const request = await findConnectRequestByUserCode(code)

  // A `pending` row whose expiry has simply passed reads the same as one a
  // sweep has already flipped to `expired` — the row is only rewritten the
  // next time something acts on it (create, poll, approve, deny), so this
  // page has to make the same call rather than trust the stored status.
  // `timed_out` is decided in SQL, against Postgres's clock, not here: a
  // Server Component calling `Date.now()` during render is impure enough
  // that the React Compiler rule refuses it outright.
  const view: ConnectView =
    !request
      ? { kind: 'not_found' }
      : request.status === 'denied'
        ? { kind: 'denied' }
        : request.status === 'consumed'
          ? { kind: 'consumed' }
          : request.status === 'expired' || (request.status === 'pending' && request.timed_out)
            ? { kind: 'expired' }
            : request.status === 'approved'
              ? { kind: 'approved', approvedRuntimes: request.approved_runtimes ?? [] }
              : {
                  kind: 'pending',
                  host: request.host,
                  runtimes: request.runtimes,
                  cliVersion: request.cli_version,
                  clientAddress: request.client_address,
                  // Device-code phishing (RFC 8628 §5.4) is someone else's
                  // pairing link approved by you, so say when it did not come
                  // from where you are.
                  sameAddress: request.client_address === clientAddress(await headers()),
                  expiresAt: request.expires_at,
                  privileged: request.runtimes.filter((runtime) => PRIVILEGED_RUNTIMES.has(runtime)),
                  isAdmin: user.role === 'admin',
                }

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg text-ui font-medium">Connect a device</span>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10">
        <ConnectApproval code={normalizeUserCode(code)} ownerName={user.displayName} view={view} />
      </div>
    </div>
  )
}

export default ConnectPage
