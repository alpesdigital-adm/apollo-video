import { createHmac } from 'node:crypto'

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
}

export function createMediaUploadSessionSignerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return new HmacMediaUploadSessionSigner({
    baseUrl: environment.APOLLO_MEDIA_UPLOAD_BASE_URL ?? 'http://127.0.0.1:3333/',
    secret: environment.APOLLO_MEDIA_UPLOAD_SIGNING_SECRET ?? '',
  })
}
