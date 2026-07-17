export interface PreflightCommitTokenClaims {
  clientId: string
  workspaceId: string
  fingerprint: string
  snapshot: string
  costFingerprint: string
  expiresAt: string
}

export interface PreflightCommitTokenIssuer {
  issue(claims: Readonly<PreflightCommitTokenClaims>): string
  verify(token: string): Readonly<PreflightCommitTokenClaims>
}
