import { NextRequest, NextResponse } from 'next/server'

import { signInWithOidcService } from '@/v2/application/sign-in-with-oidc'
import { DomainError } from '@/v2/domain/errors'
import {
  createOidcAuthorizationRepository,
  createUiSessionSecurityRepository,
  createWorkspaceMemberRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  createOidcProvider,
  APOLLO_OIDC_BINDING_COOKIE,
  oidcIdentitySubjectHash,
  resolveHumanAuthenticationMode,
  resolveOidcProviderConfiguration,
} from '@/v2/infrastructure/security/oidc-provider'
import { nodeOidcTransactionProtector } from '@/v2/infrastructure/security/oidc-transaction-protector'
import {
  APOLLO_SESSION_COOKIE,
  issueUiSession,
  isTrustedUiMutationOrigin,
  uiSessionNonceHash,
} from '@/v2/infrastructure/security/ui-session'
import { publicApiHeaders, resolveRequestId } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
function protocol(request: NextRequest): string {
  if (process.env.APOLLO_UI_TRUST_PROXY_HEADERS === 'true') {
    return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? request.nextUrl.protocol.replace(':', '')
  }
  return request.nextUrl.protocol.replace(':', '')
}

function errorResponse(requestId: string, status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, category: 'auth', retryable: status >= 500, requestId } }, {
    status, headers: publicApiHeaders(requestId),
  })
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  if (resolveHumanAuthenticationMode() !== 'oidc') return errorResponse(requestId, 403, 'AUTH_METHOD_DISABLED', 'OIDC nÃ£o estÃ¡ habilitado.')
  if (!isTrustedUiMutationOrigin({
    origin: request.headers.get('origin'), host: request.headers.get('host'), protocol: protocol(request),
    fetchSite: request.headers.get('sec-fetch-site'),
  })) return errorResponse(requestId, 403, 'AUTH_INVALID', 'Origem de autenticaÃ§Ã£o invÃ¡lida.')
  const browserBinding = request.cookies.get(APOLLO_OIDC_BINDING_COOKIE)?.value
  let body: { code?: unknown; state?: unknown }
  try { body = await request.json() as typeof body } catch { return errorResponse(requestId, 422, 'INVALID_ARGUMENT', 'Callback OIDC invÃ¡lido.') }
  if (
    typeof body.code !== 'string' || typeof body.state !== 'string' ||
    typeof browserBinding !== 'string'
  ) return errorResponse(requestId, 401, 'AUTH_INVALID', 'Callback OIDC invÃ¡lido.')
  try {
    const configuration = resolveOidcProviderConfiguration()
    const signedIn = await signInWithOidcService({
      authorizations: createOidcAuthorizationRepository(),
      protector: nodeOidcTransactionProtector(),
      provider: createOidcProvider({ configuration }),
      configuration,
      members: createWorkspaceMemberRepository(),
      sessions: createUiSessionSecurityRepository(),
      issueSessionToken: issueUiSession,
      hashIdentitySubject: oidcIdentitySubjectHash,
      hashSessionToken: uiSessionNonceHash,
    })({ code: body.code, state: body.state, browserBinding })
    const response = NextResponse.json(presentSuccess({
      workspaceId: signedIn.workspaceId,
      memberId: signedIn.memberId,
      role: signedIn.role,
      expiresAt: signedIn.expiresAt,
      redirectTo: signedIn.redirectTo,
    }), { headers: publicApiHeaders(requestId) })
    response.cookies.set(APOLLO_SESSION_COOKIE, signedIn.token, {
      httpOnly: true,
      secure: protocol(request) === 'https',
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor((new Date(signedIn.expiresAt).getTime() - Date.now()) / 1000),
    })
    response.cookies.set(APOLLO_OIDC_BINDING_COOKIE, '', {
      httpOnly: true, secure: protocol(request) === 'https', sameSite: 'strict',
      path: '/v1/session/oidc/callback', maxAge: 0,
    })
    return response
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'AUTH_INVALID' || error.code === 'INVALID_ARGUMENT')) {
      return errorResponse(requestId, 401, 'AUTH_INVALID', 'NÃ£o foi possÃ­vel validar a identidade.')
    }
    return errorResponse(requestId, 503, 'AUTH_UNAVAILABLE', 'NÃ£o foi possÃ­vel concluir o login agora.')
  }
}
