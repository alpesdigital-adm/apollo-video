import { DomainError } from '../domain/errors.ts'
import type { MediaUploadVerifier } from '../application/ports/media-transfer-repository.ts'

export class HttpMediaUploadVerifier implements MediaUploadVerifier {
  private readonly options: { baseUrl: string; token: string; fetchImplementation?: typeof fetch }

  constructor(options: { baseUrl: string; token: string; fetchImplementation?: typeof fetch }) {
    this.options = options
    const url = new URL(options.baseUrl)
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !local) throw new DomainError('INVALID_ARGUMENT', 'Media verifier URL must use HTTPS')
    if (options.token.length < 20) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media verifier token is not configured')
  }
  async verify({ upload }: Parameters<MediaUploadVerifier['verify']>[0]) {
    const url = new URL(`uploads/${encodeURIComponent(upload.id)}/verification`, this.options.baseUrl)
    const response = await (this.options.fetchImplementation ?? fetch)(url, {
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Storage could not verify uploaded media')
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > 65_536) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Storage verification response is too large')
    const body = await response.json() as Record<string, unknown>
    if (typeof body.byteSize !== 'string' || typeof body.mimeType !== 'string' || typeof body.sha256 !== 'string') {
      throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Storage verification response is invalid')
    }
    return Object.freeze({ byteSize: body.byteSize, mimeType: body.mimeType, sha256: body.sha256 })
  }
}

export function createMediaUploadVerifierFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const baseUrl = environment.APOLLO_MEDIA_STORAGE_VERIFY_BASE_URL
  const token = environment.APOLLO_MEDIA_STORAGE_VERIFY_TOKEN
  if (!baseUrl || !token) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Media storage verifier is not configured')
  return new HttpMediaUploadVerifier({ baseUrl, token })
}
