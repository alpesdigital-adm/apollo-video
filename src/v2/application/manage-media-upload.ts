import { randomUUID } from 'node:crypto'

import { assertDomain } from '../domain/errors.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { createMediaUploadPart } from '../domain/media-transfer.ts'
import { createMediaUploadAuditEntry } from '../domain/media-upload-audit-entry.ts'
import type { MediaTransferRepository, MediaUploadContentStorage, MediaUploadVerifier } from './ports/media-transfer-repository.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { authorizeMediaUploadActor } from './secure-media-upload.ts'
import { calculateVersionHash } from './version-hash.ts'

export function abortMediaUploadService(dependencies: { repository: MediaTransferRepository; storage: MediaUploadContentStorage; clock?: () => Date; createId?: () => string }) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  return async function abort(input: { workspaceId: string; actor: AuthenticatedExternalActor; uploadId: string }) {
    const audit = authorizeMediaUploadActor(input.workspaceId, input.actor)
    const occurredAt = clock().toISOString()
    const requestFingerprint = calculateVersionHash({
      action: 'media-upload.abort/v1', uploadId: input.uploadId,
      actorContextHash: audit.contextHash,
    })
    const result = await dependencies.repository.markUploadAbortedOrReplay({
      workspaceId: input.workspaceId, clientId: audit.clientId, uploadId: input.uploadId,
      auditEntry: createMediaUploadAuditEntry({
        id: createId(), workspaceId: input.workspaceId, uploadId: input.uploadId,
        action: 'abort', audit, requestFingerprint, occurredAt,
      }),
    })
    await dependencies.storage.discard(input.uploadId)
    return Object.freeze({ uploadId: result.upload.id, status: result.upload.status, aborted: true as const, replayed: result.replayed })
  }
}

export function inspectMediaUploadService(dependencies: { repository: MediaTransferRepository }) {
  return async function inspect(input: { workspaceId: string; actor: AuthenticatedExternalActor; uploadId: string }) {
    const audit = authorizeMediaUploadActor(input.workspaceId, input.actor)
    const identity = { workspaceId: input.workspaceId, clientId: audit.clientId, uploadId: input.uploadId }
    const upload = await dependencies.repository.findUpload(identity)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    const parts = await dependencies.repository.listUploadParts(identity)
    const expectedParts = upload!.sessionMode === 'multipart' && upload!.partSize
      ? Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize) - BigInt(1)) / BigInt(upload!.partSize))
      : 0
    const present = new Set(parts.map((part) => part.partNumber))
    const missingPartNumbers = Object.freeze(Array.from({ length: expectedParts }, (_, index) => index + 1).filter((part) => !present.has(part)))
    return Object.freeze({ upload, parts, missingPartNumbers })
  }
}

export function recordMediaUploadPartService(dependencies: { repository: MediaTransferRepository; clock?: () => Date }) {
  return recordMediaUploadPartWithIdentityService(dependencies, 'actor')
}

export function recordMediaUploadPartFromSessionService(dependencies: { repository: MediaTransferRepository; clock?: () => Date; createId?: () => string }) {
  return recordMediaUploadPartWithIdentityService(dependencies, 'session')
}

function recordMediaUploadPartWithIdentityService(
  dependencies: { repository: MediaTransferRepository; clock?: () => Date; createId?: () => string },
  identityKind: 'actor' | 'session',
) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  return async function record(input: {
    workspaceId: string; uploadId: string; partNumber: number; byteSize: string; etag: string; checksum: string
    actor?: AuthenticatedExternalActor; sessionAudit?: Readonly<ApiAccessAuditContext>
  }) {
    const audit = identityKind === 'actor'
      ? authorizeMediaUploadActor(input.workspaceId, input.actor!)
      : input.sessionAudit!
    assertDomain(Boolean(audit), 'AUTH_INVALID', 'Upload part audit identity is required')
    const identity = { workspaceId: input.workspaceId, clientId: audit.clientId, uploadId: input.uploadId }
    assertDomain(typeof input.byteSize === 'string' && typeof input.etag === 'string' && typeof input.checksum === 'string', 'INVALID_ARGUMENT', 'Part receipt fields must be strings')
    const upload = await dependencies.repository.findUpload(identity)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    assertDomain(upload!.sessionMode === 'multipart' && Boolean(upload!.partSize), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload is not multipart')
    assertDomain(upload!.sessionExpiresAt !== undefined && new Date(upload!.sessionExpiresAt) > clock(), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload session has expired')
    const expectedParts = Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize!) - BigInt(1)) / BigInt(upload!.partSize!))
    assertDomain(input.partNumber <= expectedParts, 'INVALID_ARGUMENT', 'partNumber exceeds the upload part count')
    const recordedAt = clock().toISOString()
    const part = createMediaUploadPart({ uploadId: input.uploadId, partNumber: input.partNumber, byteSize: input.byteSize, etag: input.etag, checksum: input.checksum, recordedAt })
    const requestFingerprint = calculateVersionHash({
      action: 'media-upload.part-record/v1', uploadId: input.uploadId,
      partNumber: part.partNumber, byteSize: part.byteSize, etag: part.etag,
      checksum: part.checksum, actorContextHash: audit.contextHash,
    })
    return dependencies.repository.recordUploadPart({
      workspaceId: input.workspaceId, clientId: audit.clientId, part,
      auditEntry: createMediaUploadAuditEntry({
        id: createId(), workspaceId: input.workspaceId, uploadId: input.uploadId,
        action: 'part-record', partNumber: part.partNumber, audit,
        requestFingerprint, occurredAt: recordedAt,
      }),
    })
  }
}

export function completeMediaUploadService(dependencies: {
  repository: MediaTransferRepository; verifier: MediaUploadVerifier; clock?: () => Date; createId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  return async function complete(input: { workspaceId: string; actor: AuthenticatedExternalActor; uploadId: string }) {
    const audit = authorizeMediaUploadActor(input.workspaceId, input.actor)
    const identity = { workspaceId: input.workspaceId, clientId: audit.clientId, uploadId: input.uploadId }
    const upload = await dependencies.repository.findUpload(identity)
    assertDomain(Boolean(upload), 'MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    if (upload!.status === 'verified') {
      assertDomain(Boolean(upload!.actualByteSize && upload!.actualSha256 && upload!.verifiedAt), 'PERSISTENCE_CONFLICT', 'Verified upload evidence is incomplete')
      return persistVerifiedUpload(dependencies.repository, createId, audit, identity, {
        byteSize: upload!.actualByteSize!, sha256: upload!.actualSha256!, verifiedAt: upload!.verifiedAt!,
      })
    }
    assertDomain(upload!.status === 'uploading', 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot be completed')
    const parts = await dependencies.repository.listUploadParts(identity)
    if (upload!.sessionMode === 'multipart') {
      assertDomain(Boolean(upload!.partSize), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Multipart upload is missing part size')
      const expected = Number((BigInt(upload!.byteSize) + BigInt(upload!.partSize!) - BigInt(1)) / BigInt(upload!.partSize!))
      assertDomain(parts.length === expected && parts.every((part, index) => part.partNumber === index + 1), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Multipart upload is incomplete')
    }
    const verified = await dependencies.verifier.verify({ upload: upload!, parts })
    assertDomain(verified.byteSize === upload!.byteSize, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded size does not match intent')
    assertDomain(verified.mimeType.toLowerCase() === upload!.mimeType, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded MIME does not match intent')
    assertDomain(verified.sha256 === upload!.expectedSha256, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Uploaded checksum does not match intent')
    return persistVerifiedUpload(dependencies.repository, createId, audit, identity, {
      byteSize: verified.byteSize, sha256: verified.sha256, verifiedAt: clock().toISOString(),
    })
  }
}

function persistVerifiedUpload(
  repository: MediaTransferRepository,
  createId: () => string,
  audit: Readonly<ApiAccessAuditContext>,
  identity: { workspaceId: string; clientId: string; uploadId: string },
  verified: { byteSize: string; sha256: string; verifiedAt: string },
) {
  const requestFingerprint = calculateVersionHash({
    action: 'media-upload.complete/v1', uploadId: identity.uploadId,
    actualByteSize: verified.byteSize, actualSha256: verified.sha256,
    actorContextHash: audit.contextHash,
  })
  return repository.markUploadVerifiedOrReplay({
    ...identity, actualByteSize: verified.byteSize, actualSha256: verified.sha256,
    verifiedAt: verified.verifiedAt,
    auditEntry: createMediaUploadAuditEntry({
      id: createId(), workspaceId: identity.workspaceId, uploadId: identity.uploadId,
      action: 'complete', audit, requestFingerprint, occurredAt: verified.verifiedAt,
    }),
  })
}
