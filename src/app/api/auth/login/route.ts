import { NextRequest, NextResponse } from 'next/server'

import {
  UI_SESSION_COOKIE,
  UI_SESSION_MAX_AGE_SECONDS,
  configuredUiUsername,
  issueUiSession,
  safeUiRedirect,
  verifyUiPassword,
} from '@/lib/ui-auth'

interface AttemptWindow { count: number; resetAt: number }

const attempts = new Map<string, AttemptWindow>()
const MAX_ATTEMPTS = 6
const WINDOW_MS = 15 * 60 * 1000

function clientKey(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

function consumeAttempt(key: string, succeeded: boolean): { blocked: boolean; retryAfter?: number } {
  const now = Date.now()
  const current = attempts.get(key)
  if (succeeded) {
    attempts.delete(key)
    return { blocked: false }
  }
  const next = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + WINDOW_MS }
    : { count: current.count + 1, resetAt: current.resetAt }
  attempts.set(key, next)
  if (attempts.size > 1_000) {
    for (const [entryKey, entry] of attempts) if (entry.resetAt <= now) attempts.delete(entryKey)
  }
  return next.count >= MAX_ATTEMPTS
    ? { blocked: true, retryAfter: Math.max(1, Math.ceil((next.resetAt - now) / 1000)) }
    : { blocked: false }
}

export async function POST(request: NextRequest) {
  const key = clientKey(request)
  const existing = attempts.get(key)
  if (existing && existing.count >= MAX_ATTEMPTS && existing.resetAt > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - Date.now()) / 1000))
    return NextResponse.json(
      { error: { code: 'LOGIN_RATE_LIMITED', message: 'Muitas tentativas. Aguarde alguns minutos.' } },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    )
  }

  let body: { username?: unknown; password?: unknown; next?: unknown }
  try {
    body = await request.json() as typeof body
  } catch {
    return NextResponse.json({ error: { code: 'INVALID_LOGIN', message: 'Preencha usuário e senha.' } }, { status: 400 })
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  let valid = false
  try {
    valid = verifyUiPassword(username, password)
  } catch {
    return NextResponse.json(
      { error: { code: 'LOGIN_NOT_CONFIGURED', message: 'O acesso ao Apollo ainda não foi configurado.' } },
      { status: 503 },
    )
  }
  const result = consumeAttempt(key, valid)
  if (!valid) {
    const headers = result.retryAfter ? { 'retry-after': String(result.retryAfter) } : undefined
    return NextResponse.json(
      { error: { code: result.blocked ? 'LOGIN_RATE_LIMITED' : 'LOGIN_INVALID', message: result.blocked ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Usuário ou senha não conferem.' } },
      { status: result.blocked ? 429 : 401, headers },
    )
  }

  const redirectTo = safeUiRedirect(body.next)
  const response = NextResponse.json({ data: { redirectTo } })
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  response.cookies.set(UI_SESSION_COOKIE, issueUiSession(configuredUiUsername()), {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:' || forwardedProto === 'https',
    sameSite: 'strict',
    path: '/',
    maxAge: UI_SESSION_MAX_AGE_SECONDS,
  })
  return response
}
