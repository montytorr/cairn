import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/cookie'

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
  // Middleware runs in an edge-like runtime and performs the cheap redirect.
  // The app layout and API handlers resolve the opaque token against Postgres
  // before they read any data.
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value)
  const isLoginRoute = req.nextUrl.pathname.startsWith('/login')

  if (!hasSession && !isLoginRoute) {
    const url = req.nextUrl.clone()
    // Carry the whole destination, query included, and clear the rest: keeping
    // the original params meant /search?q=x came back as a bare /search, and
    // leaked them onto the login URL besides.
    const target = `${req.nextUrl.pathname}${req.nextUrl.search}`
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('redirect', target)
    return NextResponse.redirect(url)
  }

  if (hasSession && isLoginRoute) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return NextResponse.next({ request: req })
}

export const config = {
  matcher: [
    /*
     * Everything except: the agent API (bearer-authenticated), Next internals,
     * the health probe, and static assets.
     *
     * `apple-icon` and `opengraph-image` are route handlers, not files, so the
     * extension rule below does not cover them — an icon behind a login
     * redirect is an icon the browser never gets.
     */
    '/((?!api/v1|api/auth|api/files|_next/static|_next/image|favicon.ico|icon|apple-icon|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
