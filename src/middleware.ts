import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Server-side route protection.
 *
 * This exists because the alternative — a client-side `useEffect` that checks
 * the session and redirects — is not access control: by the time it runs, the
 * RSC payload has already been served. a2a-comms ships exactly that pattern
 * and has no middleware at all; Cairn does not repeat it.
 *
 * /api/v1/* is excluded: those routes authenticate bearer API keys themselves,
 * and must stay reachable without a browser session.
 */
export const middleware = async (req: NextRequest) => {
  let res = NextResponse.next({ request: req })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => req.cookies.set(name, value))
          res = NextResponse.next({ request: req })
          toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
        },
      },
    },
  )

  // getUser() revalidates against the auth server; getSession() only decodes
  // the cookie, which a client could have forged.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isLoginRoute = req.nextUrl.pathname.startsWith('/login')

  if (!user && !isLoginRoute) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirect', req.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  if (user && isLoginRoute) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return res
}

export const config = {
  matcher: [
    /*
     * Everything except: the agent API (bearer-authenticated), Next internals,
     * the health probe, and static assets.
     */
    '/((?!api/v1|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
