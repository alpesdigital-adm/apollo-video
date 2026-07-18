import { NextRequest, NextResponse } from 'next/server'

import { createApiClientRepository } from '@/v2/infrastructure/repository-factory'
import {
  APOLLO_SESSION_COOKIE,
  APOLLO_SESSION_MAX_AGE_SECONDS,
  configuredUiApiClientId,
  configuredUiUsername,
  issueUiSession,
  safeUiRedirect,
  verifyUiPassword,
  verifyUiSession,
} from '@/v2/infrastructure/security/ui-session'

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

function secureCookie(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return request.nextUrl.protocol === 'https:' || forwardedProto === 'https'
}

export async function GET(request: NextRequest) {
  const session = verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json(
      { error: { code: 'AUTH_INVALID', message: 'Entre para continuar.' } },
      { status: 401 },
    )
  }
  const client = await createApiClientRepository().findActiveClientById(session.clientId)
  if (!client) {
    return NextResponse.json(
      { error: { code: 'AUTH_INVALID', message: 'A sessão não está mais autorizada.' } },
      { status: 401 },
    )
  }
  return NextResponse.json({
    data: {
      subject: session.subject,
      workspaceId: client.workspaceId,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    },
  })
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
    return NextResponse.json(
      { error: { code: 'INVALID_LOGIN', message: 'Preencha usuário e senha.' } },
      { status: 400 },
    )
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  let clientId = ''
  let validCredentials = false
  try {
    clientId = configuredUiApiClientId()
    validCredentials = verifyUiPassword(username, password)
  } catch {
    return NextResponse.json(
      { error: { code: 'LOGIN_NOT_CONFIGURED', message: 'O acesso ao Apollo ainda não foi configurado.' } },
      { status: 503 },
    )
  }
  const result = consumeAttempt(key, validCredentials)
  if (!validCredentials) {
    return NextResponse.json(
      {
        error: {
          code: result.blocked ? 'LOGIN_RATE_LIMITED' : 'LOGIN_INVALID',
          message: result.blocked
            ? 'Muitas tentativas. Aguarde alguns minutos.'
            : 'Usuário ou senha não conferem.',
        },
      },
      {
        status: result.blocked ? 429 : 401,
        ...(result.retryAfter ? { headers: { 'retry-after': String(result.retryAfter) } } : {}),
      },
    )
  }

  try {
    const client = await createApiClientRepository().findActiveClientById(clientId)
    if (!client) {
      return NextResponse.json(
        {
          error: {
            code: 'LOGIN_NOT_CONFIGURED',
            message: 'O acesso do Apollo não está vinculado a um cliente ativo.',
          },
        },
        { status: 503 },
      )
    }
  } catch {
    return NextResponse.json(
      { error: { code: 'LOGIN_NOT_CONFIGURED', message: 'O acesso ao Apollo ainda não foi configurado.' } },
      { status: 503 },
    )
  }

  const response = NextResponse.json({ data: { redirectTo: safeUiRedirect(body.next) } })
  response.cookies.set(
    APOLLO_SESSION_COOKIE,
    issueUiSession(configuredUiUsername(), clientId),
    {
      httpOnly: true,
      secure: secureCookie(request),
      sameSite: 'strict',
      path: '/',
      maxAge: APOLLO_SESSION_MAX_AGE_SECONDS,
    },
  )
  return response
}

export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ data: { signedOut: true } })
  response.cookies.set(APOLLO_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: secureCookie(request),
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return response
}
