import { assertDomain } from '../domain/errors.ts'
import type { MediaTransferRepository, MediaUploadSessionSigner } from './ports/media-transfer-repository.ts'

const SINGLE_LIMIT = BigInt(100 * 1024 * 1024)
const PART_SIZE = BigInt(64 * 1024 * 1024)

export function issueMediaUploadSessionService(dependencies: {
  repository: MediaTransferRepository
  signer: MediaUploadSessionSigner
  clock?: () => Date
  signedTtlMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const ttl = dependencies.signedTtlMs ?? 10 * 60 * 1000
  return async function issue(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const upload = await dependencies.repository.findUpload(input)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    const now = clock()
    assertDomain(new Date(upload!.expiresAt) > now, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload intent has expired')
    assertDomain(['pending-session', 'uploading'].includes(upload!.status), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot issue a session in its current state')
    assertDomain(Number.isInteger(ttl) && ttl >= 60_000 && ttl <= 15 * 60 * 1000, 'INVALID_ARGUMENT', 'signed upload TTL is invalid')
    const expiresAt = new Date(Math.min(now.getTime() + ttl, new Date(upload!.expiresAt).getTime())).toISOString()
    const size = BigInt(upload!.byteSize)
    const mode = size <= SINGLE_LIMIT ? 'single' as const : 'multipart' as const
    const maxParts = mode === 'single' ? 1 : Number((size + PART_SIZE - BigInt(1)) / PART_SIZE)
    assertDomain(maxParts <= 10_000, 'INVALID_ARGUMENT', 'Upload requires too many multipart parts')
    const updated = await dependencies.repository.markSessionIssued({
      ...input, mode, ...(mode === 'multipart' ? { partSize: PART_SIZE.toString() } : {}), sessionExpiresAt: expiresAt,
    })
    const signed = dependencies.signer.sign({ ...input, mode, maxParts, expiresAt })
    return Object.freeze({
      upload: updated,
      session: Object.freeze({
        mode, expiresAt, maxParts,
        requiredHeaders: Object.freeze({ 'content-type': upload!.mimeType, 'x-apollo-content-sha256': upload!.expectedSha256 }),
        ...(mode === 'single' ? { uploadUrl: signed.uploadUrl } : { partSize: PART_SIZE.toString(), partUrlTemplate: signed.partUrlTemplate }),
      }),
    })
  }
}
