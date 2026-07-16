import { createHmac } from 'node:crypto'

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
    const downloadUrl = new URL(`grants/${encodeURIComponent(input.grantId)}/content`, this.baseUrl)
    downloadUrl.searchParams.set('token', token)
    return Object.freeze({ token, downloadUrl: downloadUrl.toString() })
  }
}

export function createMediaDownloadGrantSignerFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const baseUrl = environment.APOLLO_MEDIA_DOWNLOAD_BASE_URL
  const secret = environment.APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET
  if (!baseUrl || !secret) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media download signer is not configured')
  return new HmacMediaDownloadGrantSigner({ baseUrl, secret })
}
