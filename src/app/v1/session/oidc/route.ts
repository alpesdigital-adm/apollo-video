import { NextRequest, NextResponse } from 'next/server'

import { beginOidcAuthorizationService } from '@/v2/application/manage-oidc-authorization'
import { createOidcAuthorizationRepository } from '@/v2/infrastructure/repository-factory'
import {
  createOidcProvider,
  APOLLO_OIDC_BINDING_COOKIE,
  resolveHumanAuthenticationMode,
  resolveOidcProviderConfiguration,
} from '@/v2/infrastructure/security/oidc-provider'
import { nodeOidcTransactionProtector } from '@/v2/infrastructure/security/oidc-transaction-protector'
import { isTrustedUiMutationOrigin } from '@/v2/infrastructure/security/ui-session'
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
  if (resolveHumanAuthenticationMode() !== 'oidc') {
    return errorResponse(requestId, 403, 'AUTH_METHOD_DISABLED', 'OIDC nÃ£o estÃ¡ habilitado.')
  }
  if (!isTrustedUiMutationOrigin({
    origin: request.headers.get('origin'), host: request.headers.get('host'), protocol: protocol(request),
    fetchSite: request.headers.get('sec-fetch-site'),
  })) return errorResponse(requestId, 403, 'AUTH_INVALID', 'Origem de autenticaÃ§Ã£o invÃ¡lida.')
  let body: { next?: unknown }
  try { body = await request.json() as typeof body } catch { return errorResponse(requestId, 422, 'INVALID_ARGUMENT', 'Retorno de login invÃ¡lido.') }
  try {
    const configuration = resolveOidcProviderConfiguration()
    const protector = nodeOidcTransactionProtector()
    const started = await beginOidcAuthorizationService({
      authorizations: createOidcAuthorizationRepository(), protector,
    })({
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      redirectUri: configuration.redirectUri,
      returnTo: body.next as string | undefined,
    })
    const authorizationUrl = await createOidcProvider({ configuration }).authorizationUrl({
      state: started.state, nonce: started.nonce, codeChallenge: started.codeChallenge,
    })
    const response = NextResponse.json(presentSuccess({
      authorizationUrl,
      recoveryUrl: configuration.recoveryUrl,
      expiresAt: started.expiresAt,
    }), { headers: publicApiHeaders(requestId) })
    response.cookies.set(APOLLO_OIDC_BINDING_COOKIE, started.browserBinding, {
      httpOnly: true,
      secure: protocol(request) === 'https',
      sameSite: 'strict',
      path: '/v1/session/oidc/callback',
      maxAge: 10 * 60,
    })
    return response
  } catch {
    return errorResponse(requestId, 503, 'AUTH_UNAVAILABLE', 'NÃ£o foi possÃ­vel iniciar o login agora.')
  }
}
