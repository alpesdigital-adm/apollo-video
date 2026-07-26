import { createHmac, timingSafeEqual } from 'node:crypto'

import type { MediaDownloadGrantSigner } from '../../application/ports/media-download-grant-repository.ts'
import { DomainError } from '../../domain/errors.ts'

export class HmacMediaDownloadGrantSigner implements MediaDownloadGrantSigner {
  private readonly baseUrl: URL
  private readonly options: { baseUrl: string; secret: string }
  constructor(options: { baseUrl: string; secret: string }) {
    this.options = options
    this.baseUrl = new URL(options.baseUrl)
    const local = this.baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(this.baseUrl.hostname)
    if (this.baseUrl.protocol !== 'https:' && !local) throw new DomainError('INVALID_ARGUMENT', 'Media download URL must use HTTPS')
    if (options.secret.length < 32) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media download signing secret is not configured')
  }
  sign(input: Parameters<MediaDownloadGrantSigner['sign']>[0]) {
    const payload = Buffer.from(JSON.stringify({ v: 1, gid: input.grantId, wid: input.workspaceId, cid: input.clientId, aid: input.artifactId, exp: input.expiresAt })).toString('base64url')
    const signature = createHmac('sha256', this.options.secret).update(payload).digest('base64url')
    const token = `${payload}.${signature}`
    const downloadUrl = new URL(`v1/media/download-grants/${encodeURIComponent(input.grantId)}/content`, this.baseUrl)
    downloadUrl.searchParams.set('token', token)
    return Object.freeze({ token, downloadUrl: downloadUrl.toString() })
  }

  verify(tokenValue: string) {
    const token = tokenValue.trim()
    if (token.length < 32 || token.length > 4096) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    const [payload, suppliedSignature, ...rest] = token.split('.')
    if (!payload || !suppliedSignature || rest.length > 0) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    const expectedSignature = createHmac('sha256', this.options.secret).update(payload).digest()
    let supplied: Buffer
    try {
      supplied = Buffer.from(suppliedSignature, 'base64url')
    } catch {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    let claims: unknown
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    if (
      typeof claims !== 'object' || claims === null || Array.isArray(claims) ||
      Object.keys(claims).some((key) => !['v', 'gid', 'wid', 'cid', 'aid', 'exp'].includes(key)) ||
      (claims as Record<string, unknown>).v !== 1 ||
      !['gid', 'wid', 'cid', 'aid', 'exp'].every((key) => {
        const value = (claims as Record<string, unknown>)[key]
        return typeof value === 'string' && value.length >= 3 && value.length <= 128
      }) ||
      Number.isNaN(Date.parse((claims as Record<string, string>).exp))
    ) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    }
    const parsed = claims as Record<'gid' | 'wid' | 'cid' | 'aid' | 'exp', string>
    return Object.freeze({
      grantId: parsed.gid,
      workspaceId: parsed.wid,
      clientId: parsed.cid,
      artifactId: parsed.aid,
      expiresAt: new Date(parsed.exp).toISOString(),
    })
  }
}

export function createMediaDownloadGrantSignerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const baseUrl = environment.APOLLO_MEDIA_DOWNLOAD_BASE_URL
  const secret = environment.APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET
  if (!baseUrl || !secret) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media download signer is not configured')
  return new HmacMediaDownloadGrantSigner({ baseUrl, secret })
}
