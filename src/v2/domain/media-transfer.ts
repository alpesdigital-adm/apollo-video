import { assertDomain } from './errors.ts'

export const MEDIA_UPLOAD_KINDS = ['video', 'audio', 'image'] as const
export type MediaUploadKind = (typeof MEDIA_UPLOAD_KINDS)[number]
export type MediaUploadStatus = 'pending-session' | 'uploading' | 'uploaded' | 'verified' | 'expired' | 'aborted'
export type MediaUploadInspectionStatus = 'pending' | 'usable' | 'quarantined'

const MIME_BY_KIND: Readonly<Record<MediaUploadKind, RegExp>> = Object.freeze({
  video: /^video\/[a-z0-9.+-]+$/,
  audio: /^audio\/[a-z0-9.+-]+$/,
  image: /^image\/[a-z0-9.+-]+$/,
})

export interface MediaUpload {
  id: string
  workspaceId: string
  clientId: string
  projectId?: string
  fileName?: string
  rightsConfirmed?: boolean
  kind: MediaUploadKind
  byteSize: string
  mimeType: string
  expectedSha256: string
  status: MediaUploadStatus
  expiresAt: string
  createdAt: string
  sessionMode?: 'single' | 'multipart'
  partSize?: string
  sessionExpiresAt?: string
  actualSha256?: string
  actualByteSize?: string
  verifiedAt?: string
  inspectionStatus?: MediaUploadInspectionStatus
  detectedMimeType?: string
  detectedExtension?: string
  probe?: Readonly<{ codec: string; duration?: number; width?: number; height?: number }>
  inspectionError?: Readonly<{ code: string; message: string; action: string }>
  inspectedAt?: string
}

export interface MediaUploadPart {
  uploadId: string
  partNumber: number
  byteSize: string
  etag: string
  checksum: string
  recordedAt: string
}

export function createMediaUploadPart(input: MediaUploadPart): Readonly<MediaUploadPart> {
  assertDomain(Number.isInteger(input.partNumber) && input.partNumber >= 1 && input.partNumber <= 10_000, 'INVALID_ARGUMENT', 'partNumber must be from 1 to 10000')
  assertDomain(/^[1-9][0-9]{0,15}$/.test(input.byteSize), 'INVALID_ARGUMENT', 'part size must be positive')
  assertDomain(/^"[A-Za-z0-9+/=_-]{8,256}"$/.test(input.etag), 'INVALID_ARGUMENT', 'part ETag is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.checksum), 'INVALID_ARGUMENT', 'part checksum must be SHA-256')
  assertDomain(!Number.isNaN(Date.parse(input.recordedAt)), 'INVALID_ARGUMENT', 'part timestamp is invalid')
  return Object.freeze({ ...input, recordedAt: new Date(input.recordedAt).toISOString() })
}

export function createMediaUpload(input: MediaUpload): Readonly<MediaUpload> {
  assertDomain(/^[0-9a-f-]{36}$/.test(input.id), 'INVALID_ARGUMENT', 'upload id must be a UUID')
  if (input.projectId !== undefined) {
    assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.projectId), 'INVALID_ARGUMENT', 'projectId is invalid')
  }
  if (input.fileName !== undefined) {
    const fileName = input.fileName.trim()
    assertDomain(fileName.length >= 1 && fileName.length <= 240 && !/[\\/\u0000-\u001f]/.test(fileName), 'INVALID_ARGUMENT', 'fileName is invalid')
  }
  if (input.rightsConfirmed !== undefined) {
    assertDomain(typeof input.rightsConfirmed === 'boolean', 'INVALID_ARGUMENT', 'rightsConfirmed must be a boolean')
  }
  assertDomain(MEDIA_UPLOAD_KINDS.includes(input.kind), 'INVALID_ARGUMENT', 'upload kind is invalid')
  assertDomain(/^[1-9][0-9]{0,15}$/.test(input.byteSize), 'INVALID_ARGUMENT', 'size must be a positive decimal string')
  assertDomain(BigInt(input.byteSize) <= BigInt('5000000000000'), 'INVALID_ARGUMENT', 'size exceeds the 5 TB upload limit')
  const mimeType = input.mimeType.trim().toLowerCase()
  assertDomain(MIME_BY_KIND[input.kind].test(mimeType), 'INVALID_ARGUMENT', 'MIME does not match upload kind')
  assertDomain(/^[a-f0-9]{64}$/.test(input.expectedSha256), 'INVALID_ARGUMENT', 'checksum must be lowercase SHA-256')
  const createdAt = new Date(input.createdAt)
  const expiresAt = new Date(input.expiresAt)
  assertDomain(!Number.isNaN(createdAt.getTime()) && !Number.isNaN(expiresAt.getTime()) && expiresAt > createdAt, 'INVALID_ARGUMENT', 'upload expiry is invalid')
  if (input.sessionMode) assertDomain(['single', 'multipart'].includes(input.sessionMode), 'INVALID_ARGUMENT', 'upload session mode is invalid')
  if (input.partSize) assertDomain(/^[1-9][0-9]{0,15}$/.test(input.partSize), 'INVALID_ARGUMENT', 'part size is invalid')
  if (input.sessionExpiresAt) {
    const sessionExpiry = new Date(input.sessionExpiresAt)
    assertDomain(!Number.isNaN(sessionExpiry.getTime()) && sessionExpiry > createdAt && sessionExpiry <= expiresAt, 'INVALID_ARGUMENT', 'signed session expiry is invalid')
  }
  if (input.actualSha256) assertDomain(/^[a-f0-9]{64}$/.test(input.actualSha256), 'INVALID_ARGUMENT', 'actual checksum is invalid')
  if (input.actualByteSize) assertDomain(/^[1-9][0-9]{0,15}$/.test(input.actualByteSize), 'INVALID_ARGUMENT', 'actual size is invalid')
  if (input.verifiedAt) assertDomain(!Number.isNaN(Date.parse(input.verifiedAt)), 'INVALID_ARGUMENT', 'verifiedAt is invalid')
  if (input.inspectionStatus) assertDomain(['pending', 'usable', 'quarantined'].includes(input.inspectionStatus), 'INVALID_ARGUMENT', 'inspectionStatus is invalid')
  if (input.detectedMimeType) assertDomain(/^(video|audio|image)\/[a-z0-9.+-]+$/.test(input.detectedMimeType), 'INVALID_ARGUMENT', 'detected MIME is invalid')
  if (input.detectedExtension) assertDomain(/^[a-z0-9]{2,8}$/.test(input.detectedExtension), 'INVALID_ARGUMENT', 'detected extension is invalid')
  if (input.inspectedAt) assertDomain(!Number.isNaN(Date.parse(input.inspectedAt)), 'INVALID_ARGUMENT', 'inspectedAt is invalid')
  if (input.probe) {
    assertDomain(
      typeof input.probe === 'object' && !Array.isArray(input.probe) &&
        typeof input.probe.codec === 'string' && input.probe.codec.length >= 1 && input.probe.codec.length <= 128 &&
        [input.probe.duration, input.probe.width, input.probe.height].every((value) => value === undefined || (Number.isFinite(value) && value! > 0)),
      'INVALID_ARGUMENT',
      'inspection probe is invalid',
    )
  }
  if (input.inspectionError) {
    assertDomain(
      typeof input.inspectionError === 'object' && !Array.isArray(input.inspectionError) &&
        typeof input.inspectionError.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(input.inspectionError.code) &&
        typeof input.inspectionError.message === 'string' && input.inspectionError.message.length >= 3 && input.inspectionError.message.length <= 500 &&
        typeof input.inspectionError.action === 'string' && input.inspectionError.action.length >= 3 && input.inspectionError.action.length <= 500,
      'INVALID_ARGUMENT',
      'inspection error is invalid',
    )
  }
  if (input.inspectionStatus === 'pending') {
    assertDomain(!input.detectedMimeType && !input.detectedExtension && !input.probe && !input.inspectionError && !input.inspectedAt, 'INVALID_ARGUMENT', 'pending inspection cannot contain evidence')
  }
  if (input.inspectionStatus === 'usable') {
    assertDomain(Boolean(input.detectedMimeType && input.detectedExtension && input.probe && !input.inspectionError && input.inspectedAt), 'INVALID_ARGUMENT', 'usable inspection evidence is incomplete')
  }
  if (input.inspectionStatus === 'quarantined') {
    assertDomain(Boolean(input.detectedMimeType && input.detectedExtension && input.inspectionError && input.inspectedAt), 'INVALID_ARGUMENT', 'quarantine evidence is incomplete')
  }
  return Object.freeze({ ...input, mimeType, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })
}
