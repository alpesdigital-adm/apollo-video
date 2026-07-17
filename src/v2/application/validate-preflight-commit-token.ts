import { assertDomain } from '../domain/errors.ts'
import type { PreflightCommitTokenIssuer } from './ports/preflight-commit-token.ts'

export function validatePreflightCommitTokenService(dependencies: { issuer: PreflightCommitTokenIssuer; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return function validate(input: { token: string; clientId: string; workspaceId: string; fingerprint: string; snapshot: string; costFingerprint: string }) {
    const claims = dependencies.issuer.verify(input.token)
    assertDomain(new Date(claims.expiresAt) > clock(), 'PREFLIGHT_TOKEN_EXPIRED', 'Preflight commit token has expired')
    const stale = claims.clientId !== input.clientId || claims.workspaceId !== input.workspaceId || claims.fingerprint !== input.fingerprint || claims.snapshot !== input.snapshot || claims.costFingerprint !== input.costFingerprint
    assertDomain(!stale, 'PREFLIGHT_TOKEN_STALE', 'Preflight commit token no longer matches the operation')
    return Object.freeze({ valid: true as const, expiresAt: claims.expiresAt })
  }
}
