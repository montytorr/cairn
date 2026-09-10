'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { browserClient } from '@/lib/supabase/browser'

export const LoginForm = () => {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)

    const { error: signInError } = await browserClient().auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setPending(false)
      return
    }

    router.replace(params.get('redirect') ?? '/')
    router.refresh()
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
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-border bg-surface focus:border-accent rounded-md border px-3 py-2 text-sm outline-none transition-colors"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-fg-muted text-xs font-medium">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-border bg-surface focus:border-accent rounded-md border px-3 py-2 text-sm outline-none transition-colors"
            />
          </label>

          {error ? (
            <p className="text-danger bg-danger-subtle rounded-md px-3 py-2 text-xs" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="bg-accent text-accent-fg mt-2 rounded-md px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-fg-subtle mt-6 text-xs leading-relaxed">
          Cairn is single-user; self-service signup is disabled. Agents authenticate with API
          keys instead of this form.
        </p>
      </div>
    </main>
  )
}

