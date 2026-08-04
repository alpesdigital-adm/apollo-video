import { createHash, randomUUID } from 'node:crypto'

import { DomainError, assertDomain } from '../domain/errors.ts'
import { createMediaUpload, type MediaUploadKind } from '../domain/media-transfer.ts'
import type { MediaTransferRepository } from './ports/media-transfer-repository.ts'
import { stableSerialize } from './version-hash.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { authorizeMediaUploadActor } from './secure-media-upload.ts'
import { createMediaUploadAuditEntry } from '../domain/media-upload-audit-entry.ts'

export function beginMediaUploadService(dependencies: {
  repository: MediaTransferRepository
  clock?: () => Date
  createId?: () => string
  sessionTtlMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const ttl = dependencies.sessionTtlMs ?? 15 * 60 * 1000
  assertDomain(Number.isInteger(ttl) && ttl >= 60_000 && ttl <= 3_600_000, 'INVALID_ARGUMENT', 'upload session TTL is invalid')

  return async function begin(input: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    projectId?: string
    fileName?: string
    rightsConfirmed?: boolean
    kind: MediaUploadKind
    size: string
    mimeType: string
    checksum: string
  }) {
    const audit = authorizeMediaUploadActor(input.workspaceId, input.actor)
    assertDomain(typeof input.kind === 'string' && typeof input.size === 'string' && typeof input.mimeType === 'string' && typeof input.checksum === 'string', 'INVALID_ARGUMENT', 'kind, size, mimeType and checksum are required strings')
    const idempotencyKey = input.idempotencyKey.trim()
    assertDomain(/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey), 'INVALID_ARGUMENT', 'A valid Idempotency-Key is required')
    const now = clock()
    const intent = {
      ...(input.projectId ? { projectId: input.projectId.trim() } : {}),
      ...(input.fileName ? { fileName: input.fileName.trim() } : {}),
      ...(input.rightsConfirmed !== undefined ? { rightsConfirmed: input.rightsConfirmed } : {}),
      kind: input.kind,
      byteSize: input.size,
      mimeType: input.mimeType.trim().toLowerCase(),
      expectedSha256: input.checksum,
    }
    const requestFingerprint = createHash('sha256').update(stableSerialize({
      schemaVersion: 'media-upload-begin/v2',
      actorContextHash: audit.contextHash,
      intent,
    })).digest('hex')
    const uploadId = createId()
    const upload = createMediaUpload({
      id: uploadId, workspaceId: input.workspaceId, clientId: audit.clientId,
      ...intent, status: 'pending-session', createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
    })
    try {
      return await dependencies.repository.createOrReplayUpload({
        upload, idempotencyKey, requestFingerprint,
        auditEntry: createMediaUploadAuditEntry({
          id: createId(), workspaceId: input.workspaceId, uploadId,
          action: 'begin', audit, requestFingerprint, occurredAt: now.toISOString(),
        }),
      })
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw error
    }
  }
}
