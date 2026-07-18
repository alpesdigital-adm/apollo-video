import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'

export interface BeginMediaUploadRecord {
  upload: Readonly<MediaUpload>
  idempotencyKey: string
  requestFingerprint: string
}

export interface MediaTransferRepository {
  createOrReplayUpload(record: BeginMediaUploadRecord): Promise<Readonly<{ upload: Readonly<MediaUpload>; replayed: boolean }>>
  findUpload(input: { workspaceId: string; clientId: string; uploadId: string }): Promise<Readonly<MediaUpload> | undefined>
  markSessionIssued(input: {
    workspaceId: string
    clientId: string
    uploadId: string
    mode: 'single' | 'multipart'
    partSize?: string
    sessionExpiresAt: string
  }): Promise<Readonly<MediaUpload>>
  listUploadParts(input: { workspaceId: string; clientId: string; uploadId: string }): Promise<readonly Readonly<MediaUploadPart>[]>
  recordUploadPart(input: { workspaceId: string; clientId: string; part: Readonly<MediaUploadPart> }): Promise<Readonly<MediaUploadPart>>
  markUploadVerified(input: {
    workspaceId: string; clientId: string; uploadId: string; actualByteSize: string; actualSha256: string; verifiedAt: string
  }): Promise<Readonly<MediaUpload>>
  markUploadAborted(input: { workspaceId: string; clientId: string; uploadId: string }): Promise<Readonly<MediaUpload>>
}

export interface MediaUploadVerifier {
  verify(input: {
    upload: Readonly<MediaUpload>
    parts: readonly Readonly<MediaUploadPart>[]
  }): Promise<Readonly<{ byteSize: string; mimeType: string; sha256: string }>>
}

export interface MediaUploadContentStorage {
  write(input: {
    upload: Readonly<MediaUpload>
    mode: 'single' | 'multipart'
    partNumber?: number
    body: ReadableStream<Uint8Array>
    contentLength?: number
  }): Promise<Readonly<{ byteSize: string; checksum: string; etag: string }>>
  discard(uploadId: string): Promise<void>
}

export interface MediaUploadSessionSigner {
  sign(input: {
    workspaceId: string
    clientId: string
    uploadId: string
    mode: 'single' | 'multipart'
    maxParts: number
    expiresAt: string
  }): Readonly<{ uploadUrl?: string; partUrlTemplate?: string }>
}
