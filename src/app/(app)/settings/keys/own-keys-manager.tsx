'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Laptop, KeyRound } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { groupKeysByHost, type HostGroup } from '@/lib/agent-key-hosts'
import { mutate } from '@/lib/api/mutate'
import type { OwnKey } from '@/lib/api/own-keys'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/control'
import { SettingsCard } from '../settings-card'

type Pending = { kind: 'key' | 'host'; id: string } | null

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * No `<form>` anywhere (CAIRN-171): every action is a `type="button"` that
 * calls `mutate`, and every confirmation is inline — the row itself asks,
 * rather than a browser dialog that blocks the tab.
 */
export const OwnKeysManager = ({ keys }: { keys: OwnKey[] }) => {
  const router = useRouter()
  const [refreshing, startRefresh] = useTransition()
  const [confirming, setConfirming] = useState<Pending>(null)
  const [busy, setBusy] = useState<Pending>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)

  const revokedCount = keys.filter((key) => key.revoked).length
  const visible = showRevoked ? keys : keys.filter((key) => !key.revoked)
  const groups = groupKeysByHost(visible)

  const revoke = async (target: NonNullable<Pending>, ids: string[], what: string) => {
    setBusy(target)
    setMessage(null)
    const results = await Promise.all(ids.map((id) => mutate(`/api/v1/me/keys/${id}`, { method: 'DELETE' })))
    const failed = results.filter((result) => !result.ok)
    setBusy(null)
    setConfirming(null)
    if (failed.length === 0) {
      setMessage({ tone: 'ok', text: `Revoked ${what}. A revoked key is refused on its very next request.` })
    } else {
      const first = failed[0]
      setMessage({
        tone: 'error',
        text:
          failed.length === ids.length
            ? (first && !first.ok ? first.error : 'Nothing was revoked.')
            : `Revoked ${ids.length - failed.length} of ${ids.length}; ${failed.length} could not be revoked.`,
      })
    }
    startRefresh(() => router.refresh())
  }

  if (keys.length === 0) {
    return (
      <div className="surface-card">
        <EmptyState
          title="No agent keys yet."
          hint={
            <>
              Run <code>cairn setup</code> on a machine and approve the link it opens: that pairs a key
              for each agent runtime on the machine.
            </>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex min-h-[1.5rem] flex-wrap items-center gap-x-4 gap-y-1">
        {message ? (
          <p
            role="status"
            className={cn(
              'enter-rise text-meta',
              message.tone === 'error' ? 'text-danger' : 'text-fg-muted',
            )}
          >
            {message.text}
          </p>
        ) : null}
        {refreshing ? <Spinner size={12} /> : null}
        {revokedCount > 0 ? (
          <Button size="sm" variant="quiet" onClick={() => setShowRevoked((shown) => !shown)} className="ml-auto">
            {showRevoked ? 'Hide revoked' : `Show ${plural(revokedCount, 'revoked key')}`}
          </Button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="surface-card">
          <EmptyState compact title="No active agent keys." hint="Every key you have is revoked." />
        </div>
      ) : (
        groups.map((group) => (
          <HostCard
            key={group.id}
            group={group}
            confirming={confirming}
            busy={busy}
            onConfirm={setConfirming}
            onRevoke={revoke}
          />
        ))
      )}
    </div>
  )
}

const HostCard = ({
  group,
  confirming,
  busy,
  onConfirm,
  onRevoke,
}: {
  group: HostGroup<OwnKey>
  confirming: Pending
  busy: Pending
  onConfirm: (pending: Pending) => void
  onRevoke: (target: NonNullable<Pending>, ids: string[], what: string) => Promise<void>
}) => {
  const active = group.keys.filter((key) => !key.revoked)
  const hostTarget = { kind: 'host', id: group.id } as const
  const confirmingHost = confirming?.kind === 'host' && confirming.id === group.id
  const revokingHost = busy?.kind === 'host' && busy.id === group.id
  const anyBusy = busy !== null

  const hostAction =
    group.paired && active.length > 0 ? (
      confirmingHost ? (
        <span className="flex items-center gap-3">
          <span className="text-fg-muted text-meta">Revoke {plural(active.length, 'key')}?</span>
          <Button
            size="sm"
            variant="dangerSolid"
            disabled={anyBusy}
            onClick={() =>
              void onRevoke(
                hostTarget,
                active.map((key) => key.id),
                `every key on ${group.host}`,
              )
            }
          >
            {revokingHost ? <Spinner size={11} /> : null}
            {revokingHost ? 'Revoking…' : 'Revoke all'}
          </Button>
          <Button size="sm" variant="quiet" disabled={revokingHost} onClick={() => onConfirm(null)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="quiet" disabled={anyBusy} onClick={() => onConfirm(hostTarget)}>
          Revoke all on this host
        </Button>
      )
    ) : undefined

  return (
    <SettingsCard
      flush
      title={group.host}
      description={
        <span className="inline-flex items-center gap-1.5">
          {group.paired ? <Laptop size={11} aria-hidden /> : <KeyRound size={11} aria-hidden />}
          {group.paired
            ? `${plural(active.length, 'active key')}, paired by cairn setup`
            : 'Keys not named for a machine — issued by an administrator, or before pairing existed'}
        </span>
      }
      action={hostAction}
    >
      <ul className="divide-border divide-y">
        {group.keys.map((key) => (
          <KeyRow
            key={key.id}
            ownKey={key}
            paired={group.paired}
            confirming={confirming?.kind === 'key' && confirming.id === key.id}
            revoking={busy?.kind === 'key' && busy.id === key.id}
            anyBusy={anyBusy}
            onConfirm={onConfirm}
            onRevoke={onRevoke}
          />
        ))}
      </ul>
    </SettingsCard>
  )
}

const KeyRow = ({
  ownKey,
  paired,
  confirming,
  revoking,
  anyBusy,
  onConfirm,
  onRevoke,
}: {
  ownKey: OwnKey
  paired: boolean
  confirming: boolean
  revoking: boolean
  anyBusy: boolean
  onConfirm: (pending: Pending) => void
  onRevoke: (target: NonNullable<Pending>, ids: string[], what: string) => Promise<void>
}) => {
  const revoked = ownKey.revoked
  const target = { kind: 'key', id: ownKey.id } as const

  return (
    <li className="row-hover group flex min-h-[2.75rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 md:px-5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-ui', revoked ? 'text-fg-subtle line-through' : 'text-fg')}>
            {ownKey.agentName}
          </span>
          <code className="text-fg-subtle shrink-0 text-meta">{ownKey.keyPrefix}…</code>
        </span>
        <span className="text-fg-subtle flex flex-wrap items-center gap-x-1.5 text-meta">
          {/* A paired key's name is just runtime + host, both already on screen. */}
          {paired ? null : <span className="text-fg-muted truncate">{ownKey.name} ·</span>}
          <span>
            Created <RelativeTime iso={ownKey.createdAt} />
          </span>
          <span>·</span>
          {ownKey.lastUsedAt ? (
            <span>
              last used <RelativeTime iso={ownKey.lastUsedAt} />
            </span>
          ) : (
            <span>never used</span>
          )}
        </span>
      </div>

      {revoked ? (
        <span className="text-fg-subtle shrink-0 text-meta">
          {ownKey.revokedAt ? (
            <>
              Revoked <RelativeTime iso={ownKey.revokedAt} />
            </>
          ) : (
            // Killed by an auth_epoch bump rather than an explicit revoke —
            // no per-key timestamp for that exists, so there is nothing to
            // put in a RelativeTime.
            'Revoked'
          )}
        </span>
      ) : confirming ? (
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-fg-muted text-meta">Revoke?</span>
          <Button
            size="sm"
            variant="dangerSolid"
            disabled={anyBusy}
            onClick={() => void onRevoke(target, [ownKey.id], `the ${ownKey.agentName} key`)}
          >
            {revoking ? <Spinner size={11} /> : null}
            {revoking ? 'Revoking…' : 'Revoke'}
          </Button>
          <Button size="sm" variant="quiet" disabled={revoking} onClick={() => onConfirm(null)}>
            Cancel
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-fg-subtle text-meta">Active</span>
          <Button
            size="sm"
            variant="quiet"
            disabled={anyBusy}
            onClick={() => onConfirm(target)}
            className="md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          >
            Revoke
          </Button>
        </span>
      )}
    </li>
  )
}
