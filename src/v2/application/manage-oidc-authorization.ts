import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  assertOidcHash,
  createOidcAuthorizationMaterial,
  oidcSecretHash,
  safeOidcReturnTo,
} from '../domain/oidc-authorization.ts'
import type { OidcAuthorizationRepository } from './ports/oidc-authorization-repository.ts'
import type { OidcTransactionProtector } from './ports/oidc-transaction-protector.ts'

const TEN_MINUTES_MS = 10 * 60 * 1000

export function beginOidcAuthorizationService(dependencies: {
  authorizations: OidcAuthorizationRepository
  protector: OidcTransactionProtector
  now?: () => Date
}) {
  return async function begin(input: {
    issuer: string
    clientId: string
    redirectUri: string
    returnTo?: string
  }) {
    const now = dependencies.now?.() ?? new Date()
    const material = createOidcAuthorizationMaterial()
    const stateHash = oidcSecretHash(material.state)
    const expiresAt = new Date(now.getTime() + TEN_MINUTES_MS)
    const returnTo = safeOidcReturnTo(input.returnTo)
    assertDomain(input.issuer.length <= 512, 'INVALID_ARGUMENT', 'OIDC issuer is invalid')
    assertDomain(input.clientId.length > 0 && input.clientId.length <= 256, 'INVALID_ARGUMENT', 'OIDC client is invalid')
    assertDomain(input.redirectUri.length > 0 && input.redirectUri.length <= 2048, 'INVALID_ARGUMENT', 'OIDC redirect URI is invalid')
    await dependencies.authorizations.deleteExpired({ before: now.toISOString(), limit: 100 })
    await dependencies.authorizations.create({
      stateHash,
      browserBindingHash: oidcSecretHash(material.browserBinding),
      nonceHash: oidcSecretHash(material.nonce),
      protectedCodeVerifier: await dependencies.protector.protect(material.codeVerifier, stateHash),
      issuer: input.issuer,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      returnTo,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    return Object.freeze({ ...material, returnTo, expiresAt: expiresAt.toISOString() })
  }
}

export function consumeOidcAuthorizationService(dependencies: {
  authorizations: OidcAuthorizationRepository
  protector: OidcTransactionProtector
  now?: () => Date
}) {
  return async function consume(input: { state: string; browserBinding: string }) {
    const stateHash = oidcSecretHash(input.state)
    const browserBindingHash = oidcSecretHash(input.browserBinding)
    assertOidcHash(stateHash)
    const authorization = await dependencies.authorizations.consume({
      stateHash,
      browserBindingHash,
      consumedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    })
    if (!authorization) throw new DomainError('AUTH_INVALID', 'OIDC authorization is invalid or expired')
    const codeVerifier = await dependencies.protector.open(authorization.protectedCodeVerifier, stateHash)
    return Object.freeze({ ...authorization, codeVerifier })
  }
}
