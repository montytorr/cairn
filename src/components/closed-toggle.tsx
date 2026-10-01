'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { PendingLink } from '@/components/pending-link'

const label = (includeClosed: boolean, hidden: number) => (includeClosed ? 'Hide closed' : `Show ${hidden} closed`)

/**
 * Flips `closed`, keeping every other parameter as it is NOW.
 *
 * The filters write the address bar with replaceState, which never re-renders
 * the server page, so a link built there carried the filters the page first
 * loaded with: choose "Everyone", press "Show closed", and the list went back
 * to your own tasks. Read from the live query string instead. `from` is a
 * one-time redirect notice and is dropped.
 */
const Live = ({ path, includeClosed, hidden, className }: Props) => {
  const params = new URLSearchParams(useSearchParams().toString())
  params.delete('from')
  if (includeClosed) params.delete('closed')
  else params.set('closed', '1')
  const qs = params.toString()
  return (
    <PendingLink href={qs ? `${path}?${qs}` : path} className={className}>
      {label(includeClosed, hidden)}
    </PendingLink>
  )
}

type Props = { path: string; includeClosed: boolean; hidden: number; className?: string }

export const ClosedToggle = (props: Props) => (
  <Suspense
    fallback={
      <PendingLink href={props.includeClosed ? props.path : `${props.path}?closed=1`} className={props.className}>
        {label(props.includeClosed, props.hidden)}
      </PendingLink>
    }
  >
    <Live {...props} />
  </Suspense>
)
