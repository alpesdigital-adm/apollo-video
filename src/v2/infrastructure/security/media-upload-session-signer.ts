import { createHmac, timingSafeEqual } from 'node:crypto'

import { DomainError } from '../../domain/errors.ts'
import type { MediaUploadSessionSigner } from '../../application/ports/media-transfer-repository.ts'

export class HmacMediaUploadSessionSigner implements MediaUploadSessionSigner {
  private readonly baseUrl: URL
  private readonly secret: string

  constructor(options: { baseUrl: string; secret: string }) {
    this.baseUrl = new URL(options.baseUrl)
    const local = this.baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(this.baseUrl.hostname)
    if (this.baseUrl.protocol !== 'https:' && !local) throw new DomainError('INVALID_ARGUMENT', 'Media upload base URL must use HTTPS')
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) throw new DomainError('INVALID_ARGUMENT', 'Media upload base URL is invalid')
    if (options.secret.length < 32) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media upload signing secret is not configured')
    this.secret = options.secret
  }

  sign(input: Parameters<MediaUploadSessionSigner['sign']>[0]) {
    const payload = Buffer.from(JSON.stringify({ v: 1, ...input }), 'utf8').toString('base64url')
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url')
    const token = `${payload}.${signature}`
    const path = `v1/media/uploads/${encodeURIComponent(input.uploadId)}/content`
    if (input.mode === 'single') {
      const url = new URL(path, this.baseUrl); url.searchParams.set('token', token)
      return Object.freeze({ uploadUrl: url.toString() })
    }
    const url = new URL(path, this.baseUrl)
    url.searchParams.set('partNumber', '{partNumber}')
    url.searchParams.set('token', token)
    return Object.freeze({ partUrlTemplate: url.toString().replace('%7BpartNumber%7D', '{partNumber}') })
  }

  authorize(token: string, now: Date = new Date()) {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload token is invalid')
    }
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url')
    const receivedBytes = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload token is invalid')
    }
    let value: Record<string, unknown>
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload token is invalid')
    }
    if (
      value.v !== 1 || Object.keys(value).some((key) => !['v', 'workspaceId', 'clientId', 'uploadId', 'mode', 'maxParts', 'expiresAt'].includes(key)) ||
      typeof value.workspaceId !== 'string' || typeof value.clientId !== 'string' || typeof value.uploadId !== 'string' ||
      !['single', 'multipart'].includes(value.mode as string) || !Number.isInteger(value.maxParts) ||
      typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now.getTime()
    ) {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload token is invalid or expired')
    }
    return Object.freeze({
      workspaceId: value.workspaceId,
      clientId: value.clientId,
      uploadId: value.uploadId,
      mode: value.mode as 'single' | 'multipart',
      maxParts: value.maxParts as number,
      expiresAt: new Date(value.expiresAt).toISOString(),
    })
  }
}

export function createMediaUploadSessionSignerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return new HmacMediaUploadSessionSigner({
    baseUrl: environment.APOLLO_MEDIA_UPLOAD_BASE_URL ?? 'http://127.0.0.1:3333/',
    secret: environment.APOLLO_MEDIA_UPLOAD_SIGNING_SECRET ?? '',
  })
}

export function createMediaUploadSessionAuthorizerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return createMediaUploadSessionSignerFromEnvironment(environment)
}
