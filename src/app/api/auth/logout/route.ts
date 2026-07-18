import { NextResponse } from 'next/server'

import { UI_SESSION_COOKIE } from '@/lib/ui-auth'

export async function POST() {
  const response = NextResponse.json({ data: { signedOut: true } })
  response.cookies.set(UI_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return response
}
