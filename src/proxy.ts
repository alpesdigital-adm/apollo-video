import { NextRequest, NextResponse } from 'next/server'

import {
  APOLLO_SESSION_COOKIE,
  safeUiRedirect,
  verifyUiSession,
} from '@/v2/infrastructure/security/ui-session'

function hasValidSession(request: NextRequest): boolean {
  return verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value) !== null
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  const authenticated = hasValidSession(request)
  if (pathname === '/login') {
    if (!authenticated) return NextResponse.next()
    const destination = safeUiRedirect(request.nextUrl.searchParams.get('next'))
    return NextResponse.redirect(new URL(destination, request.url))
  }

  if (!authenticated) {
    const login = new URL('/login', request.url)
    login.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(login)
  }

  return NextResponse.next()
}

export const config = {
  // Public APIs authenticate at the route boundary. Keeping /v1 outside Proxy is
  // also required for streaming multipart media without buffering gigabyte bodies.
  matcher: ['/((?!v1|_next/static|_next/image|favicon.ico).*)'],
}
