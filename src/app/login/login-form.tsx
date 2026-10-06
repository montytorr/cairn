'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { BookOpen, CircleAlert, Eye, EyeOff, History, ListChecks, NotebookPen } from 'lucide-react'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { BrandMark, useBrand } from '@/components/brand'
import { CairnIllustration } from './cairn-illustration'
// `?redirect=` comes from the URL bar, so it is attacker-controlled; this
// honours a same-site path only.
import { safeRedirect } from '@/lib/auth/login-redirect'

/** The four things the memory holds, for someone signing in for the first time. */
const PILLARS = [
  { icon: ListChecks, title: 'Tasks', body: 'What needs doing, and how it ended.' },
  { icon: NotebookPen, title: 'Notes', body: 'What was tried, including what failed.' },
  { icon: BookOpen, title: 'Knowledge', body: 'What stays true after the task closes.' },
  { icon: History, title: 'Sessions', body: 'Where each working session left off.' },
]

export const LoginForm = () => {
  const { name } = useBrand()
  const [reveal, setReveal] = useState(false)
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
    <main className="bg-bg grid min-h-dvh lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* The story, on a screen wide enough to tell it. */}
      <section className="border-border bg-bg-elevated relative hidden flex-col justify-between overflow-hidden border-r p-12 lg:flex">
        <div className="relative flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
          <BrandMark size={26} className="rounded-[6px]" />
          <span>{name}</span>
        </div>

        <div className="relative flex max-w-[34rem] flex-col gap-8">
          <CairnIllustration className="w-[10rem]" />
          <div>
            {/* Upright, the second half in the muted grey: the family's
                headings carry no italics and no accent-coloured words. */}
            <h2 className="font-display headline headline-xl text-fg text-[2.5rem] leading-[1.08]">
              Leave a marker <span className="text-fg-muted">for whoever comes next.</span>
            </h2>
            <p className="text-fg-muted mt-4 max-w-[28rem] text-ui leading-relaxed">
              The shared memory your agents and your team build as they work — so nobody re-debugs what
              somebody already solved.
            </p>
          </div>
        </div>

        <ul className="relative grid max-w-[34rem] grid-cols-2 gap-x-8 gap-y-4">
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-2.5">
              <Icon size={15} className="text-accent mt-0.5 shrink-0" aria-hidden />
              <span className="text-meta leading-snug">
                <span className="text-fg font-medium">{title}</span>
                <span className="text-fg-subtle block">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="relative flex items-center justify-center px-6 py-12">
        <div className="relative w-full max-w-[21rem]">
          <div className="mb-10 flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight lg:hidden">
            <BrandMark size={26} className="rounded-[6px]" />
            <span>{name}</span>
          </div>

          <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Welcome back</h1>
          <p className="text-fg-muted mt-2 text-ui">Sign in to {name}.</p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-fg-muted text-meta font-medium">Email</span>
              <Input
                type="email"
                required
                autoFocus
                autoComplete="username"
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-fg-muted text-meta font-medium">Password</span>
              <span className="relative flex">
                <Input
                  type={reveal ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  disabled={busy}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-9 pr-9"
                />
                <button
                  type="button"
                  onClick={() => setReveal((shown) => !shown)}
                  aria-label={reveal ? 'Hide password' : 'Show password'}
                  aria-pressed={reveal}
                  className="text-fg-subtle hover:text-fg absolute inset-y-0 right-0 grid w-9 place-items-center transition-colors"
                >
                  {reveal ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              </span>
            </label>

            {error ? (
              <p className="text-danger bg-danger-subtle flex items-start gap-2 rounded-md px-3 py-2 text-meta" role="alert">
                <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={busy} className="mt-2 h-9">
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

          {/* Who can come in, and how agents do: the two questions the old
              "single-user" line answered wrongly once admins could add people. */}
          <div className="border-border text-fg-subtle mt-10 flex flex-col gap-2 border-t pt-5 text-meta leading-relaxed">
            <p>No account yet? An administrator of this Cairn can add you.</p>
            <p>
              Agents don’t sign in here. They connect with an API key, which{' '}
              <code className="font-mono">cairn setup</code> pairs from your machine.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
