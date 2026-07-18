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
import { publicApiHeaders, resolveRequestId } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

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

function sessionError(
  requestId: string,
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; retryAfter?: number; category?: 'auth' | 'validation' | 'internal' } = {},
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        category: options.category ?? 'auth',
        retryable: options.retryable ?? false,
        requestId,
      },
    },
    {
      status,
      headers: {
        ...publicApiHeaders(requestId),
        ...(options.retryAfter ? { 'Retry-After': String(options.retryAfter) } : {}),
      },
    },
  )
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const session = verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value)
  if (!session) {
    return sessionError(requestId, 401, 'AUTH_INVALID', 'Entre para continuar.')
  }
  let client
  try {
    client = await createApiClientRepository().findActiveClientById(session.clientId)
  } catch {
    return sessionError(
      requestId,
      503,
      'AUTH_UNAVAILABLE',
      'Não foi possível validar a sessão agora.',
      { retryable: true, category: 'internal' },
    )
  }
  if (!client) {
    return sessionError(requestId, 401, 'AUTH_INVALID', 'A sessão não está mais autorizada.')
  }
  return NextResponse.json(
    presentSuccess({
      subject: session.subject,
      workspaceId: client.workspaceId,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    }),
    { headers: publicApiHeaders(requestId) },
  )
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const key = clientKey(request)
  const isFormLogin = request.headers.get('content-type')?.includes(
    'application/x-www-form-urlencoded',
  ) ?? false
  const existing = attempts.get(key)
  if (existing && existing.count >= MAX_ATTEMPTS && existing.resetAt > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - Date.now()) / 1000))
    return sessionError(
      requestId,
      429,
      'LOGIN_RATE_LIMITED',
      'Muitas tentativas. Aguarde alguns minutos.',
      { retryable: true, retryAfter },
    )
  }

  let body: { username?: unknown; password?: unknown; next?: unknown }
  try {
    if (isFormLogin) {
      const form = await request.formData()
      body = {
        username: form.get('username'),
        password: form.get('password'),
        next: form.get('next'),
      }
    } else {
      body = await request.json() as typeof body
    }
  } catch {
    return sessionError(
      requestId,
      422,
      'INVALID_LOGIN',
      'Preencha usuário e senha.',
      { category: 'validation' },
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
    return sessionError(
      requestId,
      503,
      'LOGIN_NOT_CONFIGURED',
      'O acesso ao Apollo ainda não foi configurado.',
      { category: 'internal' },
    )
  }
  const result = consumeAttempt(key, validCredentials)
  if (!validCredentials) {
    return sessionError(
      requestId,
      result.blocked ? 429 : 401,
      result.blocked ? 'LOGIN_RATE_LIMITED' : 'LOGIN_INVALID',
      result.blocked
        ? 'Muitas tentativas. Aguarde alguns minutos.'
        : 'Usuário ou senha não conferem.',
      {
        retryable: result.blocked,
        ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
      },
    )
  }

  let workspaceId = ''
  try {
    const client = await createApiClientRepository().findActiveClientById(clientId)
    if (!client) {
      return sessionError(
        requestId,
        503,
        'LOGIN_NOT_CONFIGURED',
        'O acesso do Apollo não está vinculado a um cliente ativo.',
        { category: 'internal' },
      )
    }
    workspaceId = client.workspaceId
  } catch {
    return sessionError(
      requestId,
      503,
      'LOGIN_NOT_CONFIGURED',
      'O acesso ao Apollo ainda não foi configurado.',
      { retryable: true, category: 'internal' },
    )
  }

  const subject = configuredUiUsername()
  const token = issueUiSession(subject, clientId)
  const session = verifyUiSession(token)
  if (!session) {
    return sessionError(
      requestId,
      503,
      'LOGIN_NOT_CONFIGURED',
      'O acesso ao Apollo ainda não foi configurado.',
      { category: 'internal' },
    )
  }
  const redirectTo = safeUiRedirect(body.next)
  const response = isFormLogin
    ? new NextResponse(null, {
      status: 303,
      headers: {
        ...publicApiHeaders(requestId),
        location: redirectTo,
      },
    })
    : NextResponse.json(
      presentSuccess({
        subject,
        workspaceId,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
        redirectTo,
      }),
      { headers: publicApiHeaders(requestId) },
    )
  response.cookies.set(
    APOLLO_SESSION_COOKIE,
    token,
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
  const requestId = resolveRequestId(request)
  const response = NextResponse.json(
    presentSuccess({ signedOut: true }),
    { headers: publicApiHeaders(requestId) },
  )
  response.cookies.set(APOLLO_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: secureCookie(request),
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return response
}
