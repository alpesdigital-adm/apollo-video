import { createHmac, timingSafeEqual } from 'node:crypto'

import type { PreflightCommitTokenClaims, PreflightCommitTokenIssuer } from '../../application/ports/preflight-commit-token.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'

const sha = /^[a-f0-9]{64}$/
const identity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const base64Url = /^[A-Za-z0-9_-]+$/
const claimKeys = ['cid', 'cost', 'exp', 'fp', 'snap', 'v', 'wid']

function validateClaims(claims: PreflightCommitTokenClaims) {
  if (
    !identity.test(claims.clientId) ||
    !identity.test(claims.workspaceId) ||
    !sha.test(claims.fingerprint) ||
    !sha.test(claims.snapshot) ||
    !sha.test(claims.costFingerprint) ||
    typeof claims.expiresAt !== 'string' ||
    claims.expiresAt.length > 40 ||
    Number.isNaN(Date.parse(claims.expiresAt))
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Preflight commit token claims are invalid')
  }
}

function invalidToken(): never {
  throw new DomainError('PREFLIGHT_TOKEN_INVALID', 'Preflight commit token is invalid')
}

function decodeBase64Url(value: string): Buffer {
  if (
    !base64Url.test(value) ||
    value.length % 4 === 1
  ) invalidToken()
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64url')
  } catch {
    invalidToken()
  }
  if (decoded.toString('base64url') !== value) invalidToken()
  return decoded
}

export class HmacPreflightCommitTokenIssuer implements PreflightCommitTokenIssuer {
  private readonly secret: string
  constructor(secret: string) {
    if (
      typeof secret !== 'string' ||
      Buffer.byteLength(secret, 'utf8') < 32 ||
      Buffer.byteLength(secret, 'utf8') > 4_096
    ) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Preflight commit token secret is not configured')
    this.secret = secret
  }
  issue(claims: Readonly<PreflightCommitTokenClaims>) {
    validateClaims(claims)
    const payload = Buffer.from(stableSerialize({
      v: 1,
      cid: claims.clientId,
      wid: claims.workspaceId,
      fp: claims.fingerprint,
      snap: claims.snapshot,
      cost: claims.costFingerprint,
      exp: claims.expiresAt,
    })).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }
  verify(token: string) {
    if (
      typeof token !== 'string' ||
      token.length < 80 ||
      token.length > 4_096
    ) invalidToken()
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) invalidToken()
    const expected = createHmac('sha256', this.secret).update(payload).digest()
    const received = decodeBase64Url(signature)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) invalidToken()
    let body: unknown
    try {
      body = JSON.parse(decodeBase64Url(payload).toString('utf8'))
    } catch {
      invalidToken()
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body)
    ) invalidToken()
    const record = body as Record<string, unknown>
    if (
      Object.keys(record).toSorted().join(',') !== claimKeys.join(',') ||
      record.v !== 1 ||
      typeof record.cid !== 'string' ||
      typeof record.wid !== 'string' ||
      typeof record.fp !== 'string' ||
      typeof record.snap !== 'string' ||
      typeof record.cost !== 'string' ||
      typeof record.exp !== 'string'
    ) invalidToken()
    const claims = {
      clientId: record.cid,
      workspaceId: record.wid,
      fingerprint: record.fp,
      snapshot: record.snap,
      costFingerprint: record.cost,
      expiresAt: record.exp,
    }
    try { validateClaims(claims) } catch { invalidToken() }
    return Object.freeze(claims)
  }
}

export function createPreflightCommitTokenIssuerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const secret = environment.APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET
  if (!secret) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Preflight commit token secret is not configured')
  return new HmacPreflightCommitTokenIssuer(secret)
}
