'use client'

import { useState } from 'react'
import { Button, Field, Input } from '@/components/ui/control'
import { SettingsCard } from './settings-card'

/**
 * Until this existed the only way to change the password was an admin command
 * over SSH — which also meant the password in use was one that had
 * been generated for the user rather than chosen by them.
 */
export const PasswordSection = () => {
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < 12
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit = next.length >= 12 && next === confirm && state !== 'saving'

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    setState('saving')
    setError(null)
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: next }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'Could not change the password.')
        setState('idle')
        return
      }
      setNext('')
      setConfirm('')
      setState('done')
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Could not change the password.')
      setState('idle')
    }
  }

  return (
    <form onSubmit={submit}>
      <SettingsCard
        title="Password"
        footer={
          <>
            <p className="text-fg-subtle min-w-0 flex-1 basis-60 text-meta leading-relaxed">
              No email reset is set up, so keep this somewhere safe.
            </p>
            <Button type="submit" variant="primary" disabled={!canSubmit} className="w-auto px-4">
              {state === 'saving' ? 'Changing…' : 'Change password'}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort}
            />
          </Field>
          <Field label="Confirm">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
          </Field>
        </div>

        {tooShort || mismatch || error || state === 'done' ? (
          <div className="mt-3 flex flex-col gap-2">
            {tooShort && (
              <p className="text-fg-subtle text-meta">At least 12 characters.</p>
            )}
            {mismatch && <p className="text-danger text-meta">These do not match.</p>}
            {error && (
              <p className="text-danger bg-danger-subtle enter-rise rounded-md px-2.5 py-1.5 text-meta">
                {error}
              </p>
            )}
            {state === 'done' && (
              <p className="text-status-done enter-rise text-meta">
                Changed. Store it somewhere safe — there is no email recovery on this instance.
              </p>
            )}
          </div>
        ) : null}
      </SettingsCard>
    </form>
  )
}
