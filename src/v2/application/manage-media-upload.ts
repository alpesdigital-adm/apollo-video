import { assertDomain } from '../domain/errors.ts'
import { createMediaUploadPart } from '../domain/media-transfer.ts'
import type { MediaTransferRepository, MediaUploadContentStorage, MediaUploadVerifier } from './ports/media-transfer-repository.ts'

export function abortMediaUploadService(dependencies: { repository: MediaTransferRepository; storage: MediaUploadContentStorage }) {
  return async function abort(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const upload = await dependencies.repository.markUploadAborted(input)
    await dependencies.storage.discard(input.uploadId)
    return Object.freeze({ uploadId: upload.id, status: upload.status, aborted: true as const })
  }
}

export function inspectMediaUploadService(dependencies: { repository: MediaTransferRepository }) {
  return async function inspect(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const upload = await dependencies.repository.findUpload(input)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    const parts = await dependencies.repository.listUploadParts(input)
    const expectedParts = upload!.sessionMode === 'multipart' && upload!.partSize
      ? Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize) - BigInt(1)) / BigInt(upload!.partSize))
      : 0
    const present = new Set(parts.map((part) => part.partNumber))
    const missingPartNumbers = Object.freeze(Array.from({ length: expectedParts }, (_, index) => index + 1).filter((part) => !present.has(part)))
    return Object.freeze({ upload, parts, missingPartNumbers })
  }
}

export function recordMediaUploadPartService(dependencies: { repository: MediaTransferRepository; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function record(input: {
    workspaceId: string; clientId: string; uploadId: string; partNumber: number; byteSize: string; etag: string; checksum: string
  }) {
    assertDomain(typeof input.byteSize === 'string' && typeof input.etag === 'string' && typeof input.checksum === 'string', 'INVALID_ARGUMENT', 'Part receipt fields must be strings')
    const upload = await dependencies.repository.findUpload(input)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    assertDomain(upload!.sessionMode === 'multipart' && Boolean(upload!.partSize), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload is not multipart')
    assertDomain(upload!.sessionExpiresAt !== undefined && new Date(upload!.sessionExpiresAt) > clock(), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload session has expired')
    const expectedParts = Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize!) - BigInt(1)) / BigInt(upload!.partSize!))
    assertDomain(input.partNumber <= expectedParts, 'INVALID_ARGUMENT', 'partNumber exceeds the upload part count')
    const part = createMediaUploadPart({ uploadId: input.uploadId, partNumber: input.partNumber, byteSize: input.byteSize, etag: input.etag, checksum: input.checksum, recordedAt: clock().toISOString() })
    return dependencies.repository.recordUploadPart({ workspaceId: input.workspaceId, clientId: input.clientId, part })
  }
}

export function completeMediaUploadService(dependencies: {
  repository: MediaTransferRepository; verifier: MediaUploadVerifier; clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function complete(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const upload = await dependencies.repository.findUpload(input)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    if (upload!.status === 'verified') return Object.freeze({ upload, replayed: true })
    assertDomain(upload!.status === 'uploading', 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot be completed')
    const parts = await dependencies.repository.listUploadParts(input)
    if (upload!.sessionMode === 'multipart') {
      assertDomain(Boolean(upload!.partSize), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Multipart upload is missing part size')
      const expected = Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize!) - BigInt(1)) / BigInt(upload!.partSize!))
      assertDomain(parts.length === expected && parts.every((part, index) => part.partNumber === index + 1), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Multipart upload is incomplete')
    }
    const verified = await dependencies.verifier.verify({ upload: upload!, parts })
    assertDomain(verified.byteSize === upload!.byteSize, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded size does not match intent')
    assertDomain(verified.mimeType.toLowerCase() === upload!.mimeType, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded MIME does not match intent')
    assertDomain(verified.sha256 === upload!.expectedSha256, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded checksum does not match intent')
    const completed = await dependencies.repository.markUploadVerified({
      ...input, actualByteSize: verified.byteSize, actualSha256: verified.sha256, verifiedAt: clock().toISOString(),
    })
    return Object.freeze({ upload: completed, replayed: false })
  }
}
