import { NextRequest, NextResponse } from 'next/server'

import { UI_SESSION_COOKIE, safeUiRedirect, verifyUiSession } from '@/lib/ui-auth'

const PUBLIC_PREFIXES = ['/v1', '/api/auth']
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function hasValidSession(request: NextRequest): boolean {
  return verifyUiSession(request.cookies.get(UI_SESSION_COOKIE)?.value) !== null
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next()
  }

  const authenticated = hasValidSession(request)
  if (pathname === '/login') {
    if (!authenticated) return NextResponse.next()
    const destination = safeUiRedirect(request.nextUrl.searchParams.get('next'))
    return NextResponse.redirect(new URL(destination, request.url))
  }

  if (!authenticated) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'UI_AUTH_REQUIRED', message: 'Entre novamente para continuar.' } },
        { status: 401 },
      )
    }
    const login = new URL('/login', request.url)
    login.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(login)
  }

  if (pathname.startsWith('/api/') && MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.get('origin')
    if (origin && origin !== request.nextUrl.origin) {
      return NextResponse.json(
        { error: { code: 'UI_ORIGIN_REJECTED', message: 'Origem da requisição não autorizada.' } },
        { status: 403 },
      )
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
