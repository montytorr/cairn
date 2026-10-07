'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronRight, Copy, KeyRound, RotateCcw, UserRoundCog, UserRoundPlus } from 'lucide-react'
import { mutate } from '@/lib/api/mutate'
import { Button, Field, Input, Select } from '@/components/ui/control'
import type { AdminUser } from '@/lib/api/users'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'

import type { AgentKey } from '@/lib/api/agent-keys'

export type UserKey = AgentKey

const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'Something went wrong.'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const UsersManager = ({ users, currentUserId }: { users: AdminUser[]; currentUserId: string }) => {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<string, UserKey[]>>({})
  const [freshKey, setFreshKey] = useState<{ userId: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  // Whose open tasks are being handed over, and to whom (CAIRN-310).
  const [handover, setHandover] = useState<{ userId: string; to: string } | null>(null)

  const successorsFor = (user: AdminUser) => users.filter((candidate) => candidate.active && candidate.id !== user.id)

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const create = () => run('create', async () => {
    const result = await mutate('/api/v1/users', {
      method: 'POST',
      body: { email, displayName, password, role },
    })
    if (!result.ok) throw new Error(result.error)
    setEmail('')
    setDisplayName('')
    setPassword('')
    setRole('member')
    router.refresh()
  })

  const update = (user: AdminUser, form: HTMLFormElement) => run(`user:${user.id}`, async () => {
    const data = new FormData(form)
    const result = await mutate(`/api/v1/users/${user.id}`, {
      method: 'PATCH',
      body: {
        email: String(data.get('email') ?? ''),
        displayName: String(data.get('displayName') ?? ''),
        role: String(data.get('role') ?? 'member'),
      },
    })
    if (!result.ok) throw new Error(result.error)
    router.refresh()
  })

  // A user who owns open work is not disabled from here: the picker below asks
  // who takes it over first, because the server refuses to orphan it.
  const startHandover = (user: AdminUser) => {
    const successors = successorsFor(user)
    const to = successors.some((candidate) => candidate.id === currentUserId) ? currentUserId : successors[0]?.id ?? ''
    setError(null)
    setHandover({ userId: user.id, to })
  }

  const deactivate = (user: AdminUser) => {
    if (user.openTaskCount > 0) return startHandover(user)
    if (!confirm(`Disable ${user.displayName}? Their sessions and active agent keys will be revoked immediately.`)) return
    void run(`user:${user.id}`, async () => {
      const result = await mutate(`/api/v1/users/${user.id}`, { method: 'DELETE' })
      if (!result.ok) {
        // Work assigned since the page loaded: refresh so the count, and the
        // picker on the next click, reflect it.
        if (result.code === 'conflict') router.refresh()
        throw new Error(result.error)
      }
      setKeys((current) => ({ ...current, [user.id]: [] }))
      router.refresh()
    })
  }

  const handOver = (user: AdminUser, reassignTo: string) => run(`user:${user.id}`, async () => {
    const result = await mutate(`/api/v1/users/${user.id}`, { method: 'DELETE', body: { reassignTo } })
    if (!result.ok) throw new Error(result.error)
    setHandover(null)
    setKeys((current) => ({ ...current, [user.id]: [] }))
    router.refresh()
  })

  const restore = (user: AdminUser) => run(`user:${user.id}`, async () => {
    const result = await mutate(`/api/v1/users/${user.id}/restore`, { method: 'POST' })
    if (!result.ok) throw new Error(result.error)
    router.refresh()
  })

  const resetPassword = (user: AdminUser, value: string) => run(`password:${user.id}`, async () => {
    const result = await mutate(`/api/v1/users/${user.id}/password`, {
      method: 'POST',
      body: { password: value },
    })
    if (!result.ok) throw new Error(result.error)
    alert(`Password reset for ${user.displayName}. Existing browser sessions were revoked.`)
  })

  const loadKeys = (userId: string) => run(`keys:${userId}`, async () => {
    const response = await fetch(`/api/v1/users/${userId}/keys`)
    const payload = await response.json().catch(() => null) as { data?: UserKey[]; error?: string } | null
    if (!response.ok) throw new Error(payload?.error || 'Could not load agent keys.')
    setKeys((current) => ({ ...current, [userId]: payload?.data ?? [] }))
  })

  const createKey = (userId: string, form: HTMLFormElement) => run(`keys:${userId}`, async () => {
    const data = new FormData(form)
    const result = await mutate<{ key: string }>(`/api/v1/users/${userId}/keys`, {
      method: 'POST',
      body: { agentName: String(data.get('agentName') ?? ''), name: String(data.get('name') ?? '') },
    })
    if (!result.ok) throw new Error(result.error)
    setFreshKey({ userId, key: result.data.key })
    form.reset()
    await loadKeys(userId)
  })

  const revokeKey = (userId: string, key: UserKey) => {
    if (!confirm(`Revoke the ${key.agentName} key? That agent will stop working immediately.`)) return
    void run(`keys:${userId}`, async () => {
      const result = await mutate(`/api/v1/users/${userId}/keys/${key.id}`, { method: 'DELETE' })
      if (!result.ok) throw new Error(result.error)
      await loadKeys(userId)
    })
  }


  return (
    <div className="flex flex-col gap-8">
      <section className="surface-card overflow-hidden">
        <header className="border-border flex items-center gap-2 border-b px-4 py-3">
          <UserRoundPlus size={15} className="text-fg-muted" aria-hidden />
          <h2 className="text-ui font-medium">Create user</h2>
        </header>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <Field label="Display name">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </Field>
          <Field label="Initial password">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} autoComplete="new-password" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
        </div>
        <footer className="border-border bg-surface-raised/30 flex justify-end border-t px-4 py-2.5">
          <Button className="w-auto" variant="primary" onClick={() => void create()} disabled={busy === 'create' || !email || !displayName || password.length < 12}>
            {busy === 'create' ? 'Creating…' : 'Create user'}
          </Button>
        </footer>
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-fg-muted text-label font-medium tracking-[0.06em] uppercase">Workspace users</h2>
          <span className="text-fg-subtle tabular text-meta">{users.length}</span>
          <span className="bg-border ml-1 h-px flex-1 self-center" />
        </div>
        <div className="stagger flex flex-col gap-3">
          {users.map((user) => (
            <article key={user.id} className={cn('surface-card p-4', !user.active && 'opacity-80')}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <strong className="text-ui font-medium">{user.displayName}</strong>
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-label uppercase tracking-wide',
                    user.role === 'admin'
                      ? 'border-accent/40 bg-accent-subtle/60 text-accent'
                      : 'border-border text-fg-muted',
                  )}
                >
                  {user.role}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-meta',
                    user.active ? 'text-status-in-review' : 'text-danger',
                  )}
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {user.active ? 'Active' : 'Disabled'}
                </span>
                <span className="text-fg-subtle tabular ml-auto flex gap-3 text-meta">
                  <span className={cn(!user.active && user.openTaskCount > 0 && 'text-danger')}>
                    {plural(user.openTaskCount, 'open task')}
                  </span>
                  <span>{user.activeKeyCount} active keys</span>
                </span>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void update(user, event.currentTarget) }}>
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
                  <Field label="Display name"><Input name="displayName" defaultValue={user.displayName} disabled={!user.active} /></Field>
                  <Field label="Email"><Input name="email" type="email" defaultValue={user.email} disabled={!user.active} /></Field>
                  <Field label="Role">
                    <Select name="role" defaultValue={user.role} disabled={!user.active}>
                      <option value="member">Member</option>
                      <option value="admin">Administrator</option>
                    </Select>
                  </Field>
                </div>
                {user.active && (
                  <div className="mt-3">
                    <Button type="submit" disabled={busy === `user:${user.id}`}>Save changes</Button>
                  </div>
                )}
              </form>
              <div className="mt-3 flex flex-wrap gap-2">
                {user.active ? (
                  <Button type="button" size="sm" variant="danger" onClick={() => deactivate(user)} disabled={busy === `user:${user.id}`}>Disable user</Button>
                ) : (
                  <Button type="button" size="sm" onClick={() => void restore(user)} disabled={busy === `user:${user.id}`}>
                    <RotateCcw size={12} aria-hidden /> Restore user
                  </Button>
                )}
                {!user.active && user.deletedAt && user.openTaskCount > 0 && handover?.userId !== user.id && (
                  <Button type="button" size="sm" onClick={() => startHandover(user)} disabled={busy === `user:${user.id}`}>
                    <UserRoundCog size={12} aria-hidden /> Reassign open tasks
                  </Button>
                )}
              </div>

              {handover?.userId === user.id && (
                <div
                  role="group"
                  aria-label={`Hand over ${user.displayName}'s open tasks`}
                  className="border-border bg-surface-raised/30 enter-rise mt-3 rounded-md border p-3"
                >
                  <p className="text-meta leading-relaxed">
                    {user.displayName} is the assignee of{' '}
                    <strong className="tabular font-medium">{plural(user.openTaskCount, 'open task')}</strong>.{' '}
                    {user.active
                      ? 'Choose who takes them over; disabling hands them on in the same step.'
                      : 'Choose who takes them over.'}
                  </p>
                  {successorsFor(user).length === 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="text-danger text-meta">No other active user can take them over.</p>
                      <Button type="button" size="sm" variant="quiet" onClick={() => setHandover(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Field label="Reassign to">
                        <Select
                          size="sm"
                          value={handover.to}
                          onChange={(event) => setHandover({ userId: user.id, to: event.target.value })}
                        >
                          {successorsFor(user).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.id === currentUserId ? `${candidate.displayName} (you)` : candidate.displayName}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Button
                        type="button"
                        size="sm"
                        variant={user.active ? 'danger' : 'secondary'}
                        onClick={() => void handOver(user, handover.to)}
                        disabled={!handover.to || busy === `user:${user.id}`}
                      >
                        {user.active ? 'Disable and reassign' : 'Reassign tasks'}
                      </Button>
                      <Button type="button" size="sm" variant="quiet" onClick={() => setHandover(null)}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}

              {user.active && (
                <div className="border-border mt-4 border-t pt-3">
                  <details className="group">
                    <summary className="text-fg-muted hover:text-fg flex w-fit cursor-pointer list-none items-center gap-1.5 text-meta font-medium transition-colors duration-[var(--dur-1)] [&::-webkit-details-marker]:hidden">
                      <ChevronRight size={12} aria-hidden className="transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)] group-open:rotate-90" />
                      Password and agent keys
                    </summary>
                    <div className="enter-rise">
                      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => {
                        event.preventDefault()
                        const value = String(new FormData(event.currentTarget).get('password') ?? '')
                        void resetPassword(user, value)
                        event.currentTarget.reset()
                      }}>
                        <Field label="New password"><Input name="password" type="password" minLength={12} required autoComplete="new-password" className="w-64" /></Field>
                        <Button type="submit" disabled={busy === `password:${user.id}`}>Reset password</Button>
                      </form>

                      <div className="mt-5">
                        {keys[user.id] === undefined ? (
                          <Button size="sm" variant="quiet" onClick={() => void loadKeys(user.id)} disabled={busy === `keys:${user.id}`}>
                            <KeyRound size={12} aria-hidden /> {busy === `keys:${user.id}` ? 'Loading…' : 'Manage agent keys'}
                          </Button>
                        ) : (
                          <>
                            <ul className="border-border divide-border stagger mb-3 divide-y overflow-hidden rounded-md border">
                              {(keys[user.id] ?? []).length === 0 && (
                                <li><EmptyState compact title="No agent keys." /></li>
                              )}
                              {(keys[user.id] ?? []).map((key) => (
                                <li key={key.id} className="row-hover flex min-h-[2.75rem] flex-wrap items-center gap-2 px-2.5 py-1.5 text-meta">
                                  <span className={key.revoked ? 'line-through text-fg-subtle' : 'text-fg'}>{key.agentName}</span>
                                  <code className="text-fg-subtle">{key.keyPrefix}…</code>
                                  {!key.revoked && <Button type="button" size="sm" variant="danger" className="ml-auto" onClick={() => revokeKey(user.id, key)}>Revoke</Button>}
                                </li>
                              ))}
                            </ul>
                            {freshKey?.userId === user.id && (
                              <div className="enter-rise mb-3 rounded-md border border-[color:color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] p-3">
                                <p className="mb-2 text-meta font-medium">New key — shown once</p>
                                <div className="flex items-center gap-2">
                                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-meta">{freshKey.key}</code>
                                  <Button size="sm" variant="primary" onClick={async () => {
                                    await navigator.clipboard.writeText(freshKey.key)
                                    setCopied(true)
                                    setTimeout(() => setCopied(false), 1600)
                                  }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</Button>
                                </div>
                              </div>
                            )}
                            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void createKey(user.id, event.currentTarget) }}>
                              <Field label="Agent name"><Input name="agentName" required pattern="[a-z][a-z0-9-]{1,40}" placeholder="claude-code" className="w-40" /></Field>
                              <Field label="Key label"><Input name="name" required placeholder="Workstation key" className="w-44" /></Field>
                              <Button type="submit" disabled={busy === `keys:${user.id}`}>Create key</Button>
                            </form>
                          </>
                        )}
                      </div>
                    </div>
                  </details>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {error && (
        <p role="alert" className="text-danger bg-danger-subtle enter-rise rounded-md px-3 py-2 text-meta">
          {error}
        </p>
      )}
    </div>
  )
}
