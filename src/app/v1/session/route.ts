import { randomUUID } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

import { authenticateUiSessionService } from '@/v2/application/authenticate-ui-session'
import {
  createDurableUiSessionService,
  reserveUiLoginAttemptService,
  revokeDurableUiSessionService,
  settleUiLoginAttemptService,
} from '@/v2/application/manage-ui-session-security'
import { DomainError } from '@/v2/domain/errors'
import { createApiClientRepository, createUiSessionSecurityRepository } from '@/v2/infrastructure/repository-factory'
import {
  APOLLO_SESSION_COOKIE,
  APOLLO_SESSION_MAX_AGE_SECONDS,
  configuredUiApiClientId,
  configuredUiUsername,
  issueUiSession,
  safeUiRedirect,
  uiLoginThrottleKey,
  uiSessionNonceHash,
  uiSessionSubjectHash,
  verifyUiPassword,
  verifyUiSession,
} from '@/v2/infrastructure/security/ui-session'
import { publicApiHeaders, resolveRequestId } from '@/v2/public-api/errors'
import { resolveApiEnvironment } from '@/v2/public-api/authentication'
import { presentSuccess } from '@/v2/public-api/presenters'

function clientKey(request: NextRequest): string {
  if (process.env.APOLLO_UI_TRUST_PROXY_HEADERS !== 'true') return 'direct'
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown-proxy'
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
  let actor
  try {
    actor = await authenticateUiSessionService({
      repository: createApiClientRepository(),
      sessions: createUiSessionSecurityRepository(),
      environment: resolveApiEnvironment(),
    })(session, uiSessionNonceHash(session.nonce), uiSessionSubjectHash(session.subject))
  } catch (error) {
    if (error instanceof DomainError && error.code === 'AUTH_INVALID') {
      return sessionError(requestId, 401, 'AUTH_INVALID', 'A sessão não está mais autorizada.')
    }
    return sessionError(
      requestId,
      503,
      'AUTH_UNAVAILABLE',
      'Não foi possível validar a sessão agora.',
      { retryable: true, category: 'internal' },
    )
  }
  return NextResponse.json(
    presentSuccess({
      subject: session.subject,
      workspaceId: actor.workspaceId,
      expiresAt: actor.sessionExpiresAt,
    }),
    { headers: publicApiHeaders(requestId) },
  )
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const isFormLogin = request.headers.get('content-type')?.includes(
    'application/x-www-form-urlencoded',
  ) ?? false
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
  let sessions: ReturnType<typeof createUiSessionSecurityRepository>
  let reservation
  try {
    sessions = createUiSessionSecurityRepository()
    reservation = await reserveUiLoginAttemptService({ sessions, id: randomUUID })({
      keyHash: uiLoginThrottleKey(clientKey(request), username),
      subjectHash: uiSessionSubjectHash(username),
      requestId,
    })
  } catch {
    return sessionError(requestId, 503, 'AUTH_UNAVAILABLE', 'Não foi possível validar o acesso agora.', { retryable: true, category: 'internal' })
  }
  if (!reservation.allowed) {
    return sessionError(requestId, 429, 'LOGIN_RATE_LIMITED', 'Muitas tentativas. Aguarde alguns minutos.', {
      retryable: true, retryAfter: reservation.retryAfterSeconds,
    })
  }
  const settle = settleUiLoginAttemptService({ sessions })
  const settleSafely = async (outcome: 'succeeded' | 'invalid' | 'configuration-error') => {
    try { await settle(reservation.attemptId!, outcome); return true } catch { return false }
  }
  let clientId = ''
  let validCredentials = false
  try {
    clientId = configuredUiApiClientId()
    validCredentials = verifyUiPassword(username, password)
  } catch {
    await settleSafely('configuration-error')
    return sessionError(
      requestId,
      503,
      'LOGIN_NOT_CONFIGURED',
      'O acesso ao Apollo ainda não foi configurado.',
      { category: 'internal' },
    )
  }
  if (!validCredentials) {
    if (!await settleSafely('invalid')) {
      return sessionError(requestId, 503, 'AUTH_UNAVAILABLE', 'Não foi possível validar o acesso agora.', { retryable: true, category: 'internal' })
    }
    return sessionError(
      requestId,
      reservation.retryAfterSeconds ? 429 : 401,
      reservation.retryAfterSeconds ? 'LOGIN_RATE_LIMITED' : 'LOGIN_INVALID',
      reservation.retryAfterSeconds
        ? 'Muitas tentativas. Aguarde alguns minutos.'
        : 'Usuário ou senha não conferem.',
      {
        retryable: Boolean(reservation.retryAfterSeconds),
        ...(reservation.retryAfterSeconds ? { retryAfter: reservation.retryAfterSeconds } : {}),
      },
    )
  }

  let workspaceId = ''
  try {
    const client = await createApiClientRepository().findActiveClientById(clientId)
    if (!client) {
      await settleSafely('configuration-error')
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
    await settleSafely('configuration-error')
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
    await settleSafely('configuration-error')
    return sessionError(
      requestId,
      503,
      'LOGIN_NOT_CONFIGURED',
      'O acesso ao Apollo ainda não foi configurado.',
      { category: 'internal' },
    )
  }
  try {
    await createDurableUiSessionService({ sessions })({
      session, nonceHash: uiSessionNonceHash(session.nonce), subjectHash: uiSessionSubjectHash(subject), workspaceId,
    })
    if (!await settleSafely('succeeded')) throw new Error('login settlement failed')
  } catch {
    return sessionError(requestId, 503, 'AUTH_UNAVAILABLE', 'Não foi possível criar a sessão agora.', { retryable: true, category: 'internal' })
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
  const session = verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value)
  if (session) {
    try {
      await revokeDurableUiSessionService({ sessions: createUiSessionSecurityRepository() })(uiSessionNonceHash(session.nonce))
    } catch {
      return sessionError(requestId, 503, 'AUTH_UNAVAILABLE', 'Não foi possível encerrar a sessão agora.', { retryable: true, category: 'internal' })
    }
  }
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
