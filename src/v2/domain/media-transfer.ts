import { assertDomain } from './errors.ts'

export const MEDIA_UPLOAD_KINDS = ['video', 'audio', 'image'] as const
export type MediaUploadKind = (typeof MEDIA_UPLOAD_KINDS)[number]
export type MediaUploadStatus = 'pending-session' | 'uploading' | 'uploaded' | 'verified' | 'expired' | 'aborted'

const MIME_BY_KIND: Readonly<Record<MediaUploadKind, RegExp>> = Object.freeze({
  video: /^video\/[a-z0-9.+-]+$/,
  audio: /^audio\/[a-z0-9.+-]+$/,
  image: /^image\/[a-z0-9.+-]+$/,
})

export interface MediaUpload {
  id: string
  workspaceId: string
  clientId: string
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
}

export function createMediaUpload(input: MediaUpload): Readonly<MediaUpload> {
  assertDomain(/^[0-9a-f-]{36}$/.test(input.id), 'INVALID_ARGUMENT', 'upload id must be a UUID')
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
  return Object.freeze({ ...input, mimeType, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })
}
