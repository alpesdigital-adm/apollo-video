import { assertDomain } from '../domain/errors.ts'
import { safeOidcReturnTo } from '../domain/oidc-authorization.ts'
import type { OidcProviderConfiguration } from './ports/oidc-provider.ts'
import type { OidcAuthorizationRepository } from './ports/oidc-authorization-repository.ts'
import type { OidcProvider } from './ports/oidc-provider.ts'
import type { OidcTransactionProtector } from './ports/oidc-transaction-protector.ts'
import type { UiSessionSecurityRepository } from './ports/ui-session-security-repository.ts'
import type { WorkspaceMemberRepository } from './ports/workspace-member-repository.ts'
import { consumeOidcAuthorizationService } from './manage-oidc-authorization.ts'
import { createDurableUiSessionService } from './manage-ui-session-security.ts'
import { resolveOidcWorkspaceMembershipService } from './workspace-members.ts'
import { UI_SESSION_IDLE_TTL_SECONDS } from './authenticate-ui-session.ts'

const ABSOLUTE_SESSION_MS = 12 * 60 * 60 * 1000

export function signInWithOidcService(dependencies: {
  authorizations: OidcAuthorizationRepository
  protector: OidcTransactionProtector
  provider: OidcProvider
  configuration: Readonly<OidcProviderConfiguration>
  members: WorkspaceMemberRepository
  sessions: UiSessionSecurityRepository
  issueSessionToken: () => string
  hashIdentitySubject: (issuer: string, subject: string) => string
  hashSessionToken: (token: string) => string
  now?: () => Date
}) {
  return async function signIn(input: { state: string; browserBinding: string; code: string }) {
    const now = dependencies.now?.() ?? new Date()
    const authorization = await consumeOidcAuthorizationService({
      authorizations: dependencies.authorizations,
      protector: dependencies.protector,
      now: () => now,
    })({ state: input.state, browserBinding: input.browserBinding })
    assertDomain(
      authorization.issuer === dependencies.configuration.issuer &&
      authorization.clientId === dependencies.configuration.clientId &&
      authorization.redirectUri === dependencies.configuration.redirectUri,
      'AUTH_INVALID',
      'OIDC authorization configuration changed before callback',
    )
    const claims = await dependencies.provider.exchangeAndVerify({
      code: input.code,
      codeVerifier: authorization.codeVerifier,
      expectedNonceHash: authorization.nonceHash,
    })
    const subjectHash = dependencies.hashIdentitySubject(claims.issuer, claims.subject)
    const membership = await resolveOidcWorkspaceMembershipService({ members: dependencies.members })({
      issuer: claims.issuer,
      subjectHash,
    })
    const token = dependencies.issueSessionToken()
    const expiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_MS)
    await createDurableUiSessionService({ sessions: dependencies.sessions })({
      grant: {
        clientId: membership.uiClientId,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      nonceHash: dependencies.hashSessionToken(token),
      subjectHash,
      workspaceId: membership.workspaceId,
      memberId: membership.memberId,
    })
    return Object.freeze({
      token,
      workspaceId: membership.workspaceId,
      memberId: membership.memberId,
      role: membership.role,
      expiresAt: expiresAt.toISOString(),
      redirectTo: safeOidcReturnTo(authorization.returnTo),
      idleTtlSeconds: UI_SESSION_IDLE_TTL_SECONDS,
    })
  }
}
