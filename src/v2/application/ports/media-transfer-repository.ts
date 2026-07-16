import type { MediaUpload } from '../../domain/media-transfer.ts'

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
