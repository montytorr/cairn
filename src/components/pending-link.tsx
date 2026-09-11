'use client'

import Link, { useLinkStatus } from 'next/link'
import { Spinner } from '@/components/spinner'

/**
 * A link that says it is working.
 *
 * `loading.tsx` covers a change of route segment, but not a change of query
 * string on the same one — so "Show 2,519 closed", which re-runs a query over
 * every task in the project, looked like a dead link for as long as it took.
 * `useLinkStatus` reports the pending state of the Link it sits inside, which
 * is why the spinner has to be its own child component.
 */
const Indicator = ({ children }: { children: React.ReactNode }) => {
  const { pending } = useLinkStatus()
  return (
    <>
      {pending && <Spinner size={11} />}
      {children}
    </>
  )
}

export const PendingLink = ({
  href,
  className,
  children,
  prefetch,
}: {
  href: string
  className?: string
  children: React.ReactNode
  prefetch?: boolean
}) => (
  <Link href={href} prefetch={prefetch} className={className}>
    <Indicator>{children}</Indicator>
  </Link>
)
