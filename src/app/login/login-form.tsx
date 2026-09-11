'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'

/**
 * `?redirect=` comes from the URL bar, so it is attacker-controlled. Only a
 * same-site path is honoured — `//host` and `https://host` are absolute
 * despite the leading slash, and would turn the login page into an open
 * redirect.
 */
const safeRedirect = (value: string | null) =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/'

export const LoginForm = () => {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The sign-in call is quick; rendering the first page is not. Without this
  // the button reverted to "Sign in" the instant the token arrived and then
  // nothing moved for a second or two, which reads exactly as broken.
  const [navigating, startNavigation] = useTransition()
  const busy = pending || navigating

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)

    // Everything is inside try/catch so a thrown error surfaces instead of
    // leaving the button stuck on "Signing in…" forever — which is exactly
    // how the build-time-env bug presented, and made it far harder to read
    // than it needed to be.
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'Sign-in failed.')
        setPending(false)
        return
      }

      // Deliberately no setPending(false) on this path: the form stays busy
      // until the destination has actually rendered.
      startNavigation(() => {
        router.replace(safeRedirect(params.get('redirect')))
        router.refresh()
      })
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Sign-in failed.')
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Cairn</h1>
          <p className="text-fg-muted mt-1 text-sm">Sign in to continue.</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-fg-muted text-xs font-medium">Email</span>
            <Input
              type="email"
              required
              autoComplete="username"
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-fg-muted text-xs font-medium">Password</span>
            <Input
              type="password"
              required
              autoComplete="current-password"
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? (
            <p className="text-danger bg-danger-subtle rounded-md px-3 py-2 text-xs" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            className="mt-2"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                {navigating ? 'Loading your tasks…' : 'Signing in…'}
              </span>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>

        <p className="text-fg-subtle mt-6 text-xs leading-relaxed">
          Cairn is single-user; self-service signup is disabled. Agents authenticate with API
          keys instead of this form.
        </p>
      </div>
    </main>
  )
}
