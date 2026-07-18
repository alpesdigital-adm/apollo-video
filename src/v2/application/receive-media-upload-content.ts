import { assertDomain } from '../domain/errors.ts'
import type { MediaTransferRepository, MediaUploadContentStorage } from './ports/media-transfer-repository.ts'
import { recordMediaUploadPartService } from './manage-media-upload.ts'

export function receiveMediaUploadContentService(dependencies: {
  repository: MediaTransferRepository
  storage: MediaUploadContentStorage
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function receive(input: {
    workspaceId: string
    clientId: string
    uploadId: string
    mode: 'single' | 'multipart'
    maxParts: number
    partNumber?: number
    mimeType: string
    expectedSha256: string
    body: ReadableStream<Uint8Array>
    contentLength?: number
  }) {
    const upload = await dependencies.repository.findUpload(input)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    assertDomain(upload!.status === 'uploading' && upload!.sessionMode === input.mode, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload session is not active')
    assertDomain(upload!.sessionExpiresAt !== undefined && new Date(upload!.sessionExpiresAt) > clock(), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload session has expired')
    assertDomain(upload!.mimeType === input.mimeType.toLowerCase(), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded MIME does not match the signed intent')
    assertDomain(upload!.expectedSha256 === input.expectedSha256, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded checksum header does not match the signed intent')
    assertDomain(input.mode === 'single' ? input.partNumber === undefined : Number.isInteger(input.partNumber), 'INVALID_ARGUMENT', 'partNumber does not match upload mode')
    if (input.partNumber !== undefined) assertDomain(input.partNumber <= input.maxParts, 'INVALID_ARGUMENT', 'partNumber exceeds the signed session')

    const receipt = await dependencies.storage.write({
      upload: upload!,
      mode: input.mode,
      ...(input.partNumber !== undefined ? { partNumber: input.partNumber } : {}),
      body: input.body,
      ...(input.contentLength !== undefined ? { contentLength: input.contentLength } : {}),
    })
    if (input.mode === 'multipart') {
      const part = await recordMediaUploadPartService({ repository: dependencies.repository, clock })({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        uploadId: input.uploadId,
        partNumber: input.partNumber!,
        ...receipt,
      })
      return Object.freeze({ receipt, part })
    }
    return Object.freeze({ receipt })
  }
}
