'use client'

import { useState } from 'react'
import { Button, Field, Input } from '@/components/ui/control'

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
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-fg-muted text-[10.5px] font-medium tracking-[0.06em] uppercase">
          Password
        </h2>
        <span className="bg-border ml-1 h-px flex-1" />
      </div>

      <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
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

        {tooShort && (
          <p className="text-fg-subtle text-[11px]">At least 12 characters.</p>
        )}
        {mismatch && <p className="text-danger text-[11px]">These do not match.</p>}
        {error && (
          <p className="text-danger bg-danger-subtle rounded px-2 py-1.5 text-[11px]">{error}</p>
        )}
        {state === 'done' && (
          <p className="text-status-done text-[11px]">
            Changed. Store it somewhere safe — there is no email recovery on this instance.
          </p>
        )}

        <Button type="submit" variant="primary" disabled={!canSubmit} className="w-auto self-start px-4">
          {state === 'saving' ? 'Changing…' : 'Change password'}
        </Button>
      </form>

      <p className="text-fg-subtle mt-3 max-w-sm text-[11px] leading-relaxed">
        There is no SMTP configured, so a forgotten password can only be reset from the host.
        Keep this in a password manager.
      </p>
    </section>
  )
}
