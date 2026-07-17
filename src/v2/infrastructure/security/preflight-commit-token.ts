import { createHmac, timingSafeEqual } from 'node:crypto'

import type { PreflightCommitTokenClaims, PreflightCommitTokenIssuer } from '../../application/ports/preflight-commit-token.ts'
import { DomainError } from '../../domain/errors.ts'

const sha = /^[a-f0-9]{64}$/

function validateClaims(claims: PreflightCommitTokenClaims) {
  if (!claims.clientId || !claims.workspaceId || !sha.test(claims.fingerprint) || !sha.test(claims.snapshot) || !sha.test(claims.costFingerprint) || Number.isNaN(Date.parse(claims.expiresAt))) {
    throw new DomainError('INVALID_ARGUMENT', 'Preflight commit token claims are invalid')
  }
}

export class HmacPreflightCommitTokenIssuer implements PreflightCommitTokenIssuer {
  private readonly secret: string
  constructor(secret: string) {
    if (secret.length < 32) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Preflight commit token secret is not configured')
    this.secret = secret
  }
  issue(claims: Readonly<PreflightCommitTokenClaims>) {
    validateClaims(claims)
    const payload = Buffer.from(JSON.stringify({ v: 1, cid: claims.clientId, wid: claims.workspaceId, fp: claims.fingerprint, snap: claims.snapshot, cost: claims.costFingerprint, exp: claims.expiresAt })).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }
  verify(token: string) {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid')
    const expected = createHmac('sha256', this.secret).update(payload).digest()
    let received: Buffer
    try { received = Buffer.from(signature, 'base64url') } catch { throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid') }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid')
    let body: Record<string, unknown>
    try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> } catch { throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid') }
    if (body.v !== 1 || typeof body.cid !== 'string' || typeof body.wid !== 'string' || typeof body.fp !== 'string' || typeof body.snap !== 'string' || typeof body.cost !== 'string' || typeof body.exp !== 'string') throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid')
    const claims = { clientId: body.cid, workspaceId: body.wid, fingerprint: body.fp, snapshot: body.snap, costFingerprint: body.cost, expiresAt: body.exp }
    try { validateClaims(claims) } catch { throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid') }
    return Object.freeze(claims)
  }
}

export function createPreflightCommitTokenIssuerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const secret = environment.APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET
  if (!secret) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Preflight commit token secret is not configured')
  return new HmacPreflightCommitTokenIssuer(secret)
}
