'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useSupabaseConfig } from '@/components/supabase-provider'
import { Button, Input } from '@/components/ui/control'

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
  const { url, anonKey } = useSupabaseConfig()
  const configured = Boolean(url && anonKey)
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)

    // Everything is inside try/finally so a thrown error surfaces instead of
    // leaving the button stuck on "Signing in…" forever — which is exactly
    // how the build-time-env bug presented, and made it far harder to read
    // than it needed to be.
    try {
      const supabase = createBrowserClient(url, anonKey)
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (signInError) {
        setError(signInError.message)
        return
      }

      router.replace(safeRedirect(params.get('redirect')))
      router.refresh()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Sign-in failed.')
    } finally {
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {!configured ? (
            <p className="text-danger bg-danger-subtle rounded-md px-3 py-2 text-xs leading-relaxed">
              This instance is misconfigured: <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are not reaching the server. Check the
              container environment.
            </p>
          ) : null}

          {error ? (
            <p className="text-danger bg-danger-subtle rounded-md px-3 py-2 text-xs" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            disabled={pending || !configured}
            className="mt-2"
          >
            {pending ? 'Signing in…' : 'Sign in'}
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

