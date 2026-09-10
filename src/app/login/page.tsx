import { Suspense } from 'react'
import { LoginForm } from './login-form'

/**
 * The form reads `?redirect=` via useSearchParams(), which requires a Suspense
 * boundary at prerender time — hence the split.
 */
const LoginPage = () => (
  <Suspense
    fallback={
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-fg-subtle text-sm">Loading…</p>
      </main>
    }
  >
    <LoginForm />
  </Suspense>
)

export default LoginPage
