import { NextRequest, NextResponse } from 'next/server'

import { authenticateUiSessionService } from '@/v2/application/authenticate-ui-session'
import { rotateDurableUiSessionService } from '@/v2/application/manage-ui-session-security'
import { listSelectableWorkspacesService, resolveWorkspaceSwitchTargetService } from '@/v2/application/workspace-members'
import { DomainError } from '@/v2/domain/errors'
import {
  createApiClientRepository,
  createUiSessionSecurityRepository,
  createWorkspaceMemberRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  APOLLO_SESSION_COOKIE,
  isTrustedUiMutationOrigin,
  issueUiSession,
  uiSessionNonceHash,
  uiSessionSubjectHash,
  verifyUiSession,
} from '@/v2/infrastructure/security/ui-session'
import { resolveApiEnvironment } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

function errorResponse(requestId: string, status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, category: status === 422 ? 'validation' : 'auth', retryable: false, requestId } }, {
    status,
    headers: publicApiHeaders(requestId),
  })
}

function isSameOrigin(request: NextRequest): boolean {
  const trustProxy = process.env.APOLLO_UI_TRUST_PROXY_HEADERS === 'true'
  return isTrustedUiMutationOrigin({
    origin: request.headers.get('origin'),
    fetchSite: request.headers.get('sec-fetch-site'),
    host: trustProxy
      ? request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? null
      : request.headers.get('host'),
    protocol: trustProxy
      ? request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? null
      : request.nextUrl.protocol.slice(0, -1),
  })
}

function secureCookie(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return request.nextUrl.protocol === 'https:' || forwardedProto === 'https'
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  if (!isSameOrigin(request)) return errorResponse(requestId, 403, 'AUTH_INVALID', 'A origem da troca de workspace não é autorizada.')

  let body: { workspaceId?: unknown }
  try {
    body = await request.json() as typeof body
  } catch {
    return errorResponse(requestId, 422, 'INVALID_ARGUMENT', 'Informe um workspace válido.')
  }
  if (
    !body || typeof body !== 'object' || Object.keys(body).length !== 1 ||
    typeof body.workspaceId !== 'string' || body.workspaceId.length < 1 || body.workspaceId.length > 128
  ) return errorResponse(requestId, 422, 'INVALID_ARGUMENT', 'Informe um workspace válido.')

  const session = verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value)
  if (!session) return errorResponse(requestId, 401, 'AUTH_INVALID', 'Entre para continuar.')
  const nonceHash = uiSessionNonceHash(session.nonce)
  const subjectHash = uiSessionSubjectHash(session.subject)
  const environment = resolveApiEnvironment()
  const sessions = createUiSessionSecurityRepository()
  const members = createWorkspaceMemberRepository()
  try {
    const actor = await authenticateUiSessionService({
      repository: createApiClientRepository(), sessions, environment,
    })(session, nonceHash, subjectHash)
    const target = await resolveWorkspaceSwitchTargetService({ members })({
      memberId: actor.delegatedUserId!, workspaceId: body.workspaceId,
    })
    const selectable = await listSelectableWorkspacesService({ members })(target.memberId)
    const workspaces = selectable.map(({ uiClientId: _uiClientId, ...workspace }) => workspace)
    if (target.workspaceId === actor.workspaceId) {
      return NextResponse.json(presentSuccess({
        workspaceId: target.workspaceId,
        memberId: target.memberId,
        role: target.role,
        expiresAt: actor.sessionExpiresAt,
        workspaces,
        rotated: false,
      }), { headers: publicApiHeaders(requestId) })
    }

    const now = new Date()
    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (session.expiresAt <= nowSeconds) throw new DomainError('AUTH_INVALID', 'Apollo session expired')
    const token = issueUiSession(session.subject, target.uiClientId, { now, expiresAt: session.expiresAt })
    const nextSession = verifyUiSession(token, { now })
    if (!nextSession) throw new DomainError('AUTH_INVALID', 'Rotated Apollo session is invalid')
    await rotateDurableUiSessionService({ sessions, now: () => now })({
      currentNonceHash: nonceHash,
      session: nextSession,
      nonceHash: uiSessionNonceHash(nextSession.nonce),
      subjectHash,
      workspaceId: target.workspaceId,
      clientId: target.uiClientId,
      memberId: target.memberId,
      environment,
    })
    const response = NextResponse.json(presentSuccess({
      workspaceId: target.workspaceId,
      memberId: target.memberId,
      role: target.role,
      expiresAt: new Date(nextSession.expiresAt * 1000).toISOString(),
      workspaces,
      rotated: true,
    }), { headers: publicApiHeaders(requestId) })
    response.cookies.set(APOLLO_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie(request),
      sameSite: 'strict',
      path: '/',
      maxAge: nextSession.expiresAt - nowSeconds,
    })
    return response
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'AUTH_INVALID' || error.code === 'INVALID_ARGUMENT')) {
      return errorResponse(requestId, error.code === 'INVALID_ARGUMENT' ? 422 : 403, error.code, error.message)
    }
    return NextResponse.json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Não foi possível trocar o workspace agora.', category: 'internal', retryable: true, requestId } }, {
      status: 503,
      headers: publicApiHeaders(requestId),
    })
  }
}
