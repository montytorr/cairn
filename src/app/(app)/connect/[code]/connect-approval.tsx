'use client'

import { useEffect, useState } from 'react'
import { Check, CircleAlert, CircleCheck, MonitorSmartphone, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'

export type ConnectView =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'consumed' }
  | { kind: 'approved'; approvedRuntimes: string[] }
  | {
      kind: 'pending'
      host: string
      runtimes: string[]
      cliVersion: string | null
      clientAddress: string | null
      sameAddress: boolean
      expiresAt: string
      /** Runtimes whose key is a grant over everyone's work, not an identity. */
      privileged: string[]
      isAdmin: boolean
    }

const timeLeft = (expiresAt: string): string => {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const Message = ({ title, body, done = false }: { title: string; body: string; done?: boolean }) => (
  <div className="surface-card enter-rise flex w-full max-w-[24rem] flex-col items-center gap-2 px-6 py-8 text-center">
    {done ? (
      <CircleCheck size={20} className="text-status-done" aria-hidden />
    ) : (
      <CircleAlert size={20} className="text-fg-subtle" aria-hidden />
    )}
    <h1 className="text-fg text-[1.125rem] font-medium">{title}</h1>
    <p className="text-fg-subtle text-ui leading-relaxed">{body}</p>
  </div>
)

/**
 * No nested forms (CAIRN-171): this is a plain card with `type="button"`
 * actions that call `fetch` directly, never a `<form>` wrapping the runtime
 * checkboxes.
 */
export const ConnectApproval = ({
  code,
  ownerName,
  view,
}: {
  code: string
  ownerName: string
  view: ConnectView
}) => {
  if (view.kind === 'not_found') {
    return (
      <Message
        title="No such request"
        body="Check the code and try again, or restart the connection from the CLI."
      />
    )
  }
  if (view.kind === 'expired') {
    return (
      <Message
        title="This request has expired"
        body="Pairing codes are only good for a few minutes. Restart the connection from the CLI to get a new one."
      />
    )
  }
  if (view.kind === 'denied') {
    return (
      <Message
        title="Request denied"
        body="This pairing request was denied. Restart the connection from the CLI if that wasn't intentional."
      />
    )
  }
  if (view.kind === 'consumed') {
    return <Message done title="Already connected" body="This pairing request already finished. Its code can't be reused." />
  }
  if (view.kind === 'approved') {
    return (
      <Message
        done
        title="Approved"
        body={`Waiting for the CLI to finish connecting (${view.approvedRuntimes.join(', ')}).`}
      />
    )
  }

  return <PendingCard code={code} ownerName={ownerName} view={view} />
}

const PendingCard = ({
  code,
  ownerName,
  view,
}: {
  code: string
  ownerName: string
  view: Extract<ConnectView, { kind: 'pending' }>
}) => {
  const locked = (runtime: string) => view.privileged.includes(runtime) && !view.isAdmin
  const [selected, setSelected] = useState<string[]>(() => view.runtimes.filter((runtime) => !locked(runtime)))
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)
  const [left, setLeft] = useState(() => timeLeft(view.expiresAt))

  // A ticking clock, not a poll: nothing here needs to know if the request
  // was acted on elsewhere before this tab's own action resolves that.
  useEffect(() => {
    const id = setInterval(() => setLeft(timeLeft(view.expiresAt)), 1000)
    return () => clearInterval(id)
  }, [view.expiresAt])

  const toggle = (runtime: string) => {
    setSelected((current) => (current.includes(runtime) ? current.filter((r) => r !== runtime) : [...current, runtime]))
  }

  const act = async (action: 'approve' | 'deny') => {
    setBusy(action)
    setError(null)
    const result = await mutate(`/api/v1/connect/${code}/${action}`, {
      method: 'POST',
      body: action === 'approve' ? { runtimes: selected } : {},
    })
    if (!result.ok) {
      setError(result.error)
      setBusy(null)
      return
    }
    setDone(action === 'approve' ? 'approved' : 'denied')
  }

  if (done === 'approved') {
    return <Message done title="Approved" body="Return to the terminal — it should finish connecting in a moment." />
  }
  if (done === 'denied') {
    return <Message title="Request denied" body="Nothing was connected. Restart from the CLI if that wasn't intentional." />
  }

  const expired = left === 'expired'

  return (
    <div className="surface-card enter-rise w-full max-w-[24rem] overflow-hidden">
      <header className="border-border flex items-center gap-2.5 border-b px-5 py-3.5">
        <MonitorSmartphone size={16} className="text-fg-subtle shrink-0" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-fg text-ui font-medium">Connect {view.host}</h1>
          <p className="text-fg-subtle text-meta">Keys will belong to {ownerName}.</p>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-meta">
          <dt className="text-fg-subtle">Host</dt>
          <dd className="text-fg truncate" title="As the device reported it — not verified">
            {view.host} <span className="text-fg-subtle">(as reported)</span>
          </dd>
          <dt className="text-fg-subtle">CLI version</dt>
          <dd className="text-fg truncate">{view.cliVersion ?? 'unknown'}</dd>
          <dt className="text-fg-subtle">Requesting from</dt>
          <dd className="text-fg truncate">{view.clientAddress ?? 'unknown'}</dd>
          <dt className="text-fg-subtle">Expires in</dt>
          <dd className={expired ? 'text-danger' : 'text-fg'}>{left}</dd>
        </dl>

        <p className="text-fg-muted flex items-start gap-2 text-meta leading-relaxed">
          <TriangleAlert size={14} className="mt-px shrink-0 text-[var(--priority-high)]" aria-hidden />
          <span>
            Approve only if you just ran <code className="font-mono">cairn setup</code> on this machine yourself. Never
            approve a link someone sent you: the keys would be yours, in their hands.
            {view.sameAddress ? null : (
              <strong className="text-fg mt-1 block font-medium">
                This request came from a different network address than yours.
              </strong>
            )}
          </span>
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-meta font-medium">Runtimes</span>
          {view.runtimes.map((runtime) => {
            const checked = selected.includes(runtime)
            const privileged = view.privileged.includes(runtime)
            return (
              <button
                key={runtime}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(runtime)}
                disabled={expired || busy !== null || locked(runtime)}
                title={locked(runtime) ? 'Only an administrator can approve this key.' : undefined}
                className="border-border hover:bg-surface-raised flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-1)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  aria-hidden
                  className={`grid size-[0.75rem] shrink-0 place-items-center rounded-[3px] border ${
                    checked ? 'border-accent bg-accent' : 'border-border-strong'
                  }`}
                >
                  {checked ? <Check size={9} className="text-white" strokeWidth={3} /> : null}
                </span>
                <span className="text-fg text-ui">{runtime}</span>
                {privileged ? (
                  <span className="text-fg-subtle ml-auto text-meta">
                    {view.isAdmin ? 'acts on everyone’s claims' : 'administrators only'}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        {error ? (
          <p className="text-danger bg-danger-subtle flex items-start gap-2 rounded-md px-3 py-2 text-meta" role="alert">
            <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>

      <footer className="border-border bg-surface-raised/30 flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button type="button" variant="ghost" disabled={busy !== null || expired} onClick={() => act('deny')}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy !== null || expired || selected.length === 0}
          onClick={() => act('approve')}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
      </footer>
    </div>
  )
}
