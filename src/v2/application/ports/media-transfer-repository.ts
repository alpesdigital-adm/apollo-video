import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'
import type { MediaUploadAuditEntry } from '../../domain/media-upload-audit-entry.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface BeginMediaUploadRecord {
  upload: Readonly<MediaUpload>
  idempotencyKey: string
  requestFingerprint: string
  auditEntry: Readonly<MediaUploadAuditEntry>
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
    auditEntry: Readonly<MediaUploadAuditEntry>
  }): Promise<Readonly<MediaUpload>>
  listUploadParts(input: { workspaceId: string; clientId: string; uploadId: string }): Promise<readonly Readonly<MediaUploadPart>[]>
  recordUploadPart(input: { workspaceId: string; clientId: string; part: Readonly<MediaUploadPart>; auditEntry: Readonly<MediaUploadAuditEntry> }): Promise<Readonly<MediaUploadPart>>
  markUploadVerifiedOrReplay(input: {
    workspaceId: string; clientId: string; uploadId: string; actualByteSize: string; actualSha256: string; verifiedAt: string
    auditEntry: Readonly<MediaUploadAuditEntry>
  }): Promise<Readonly<{ upload: Readonly<MediaUpload>; replayed: boolean }>>
  markUploadAbortedOrReplay(input: {
    workspaceId: string; clientId: string; uploadId: string; auditEntry: Readonly<MediaUploadAuditEntry>
  }): Promise<Readonly<{ upload: Readonly<MediaUpload>; replayed: boolean }>>
  findCurrentUploadSessionAudit(input: {
    workspaceId: string; clientId: string; uploadId: string; sessionExpiresAt: string
  }): Promise<Readonly<ApiAccessAuditContext> | undefined>
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
