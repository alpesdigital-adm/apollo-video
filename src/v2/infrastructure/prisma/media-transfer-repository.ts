import type { PrismaClient } from '@prisma/client'

import type { MediaTransferRepository } from '../../application/ports/media-transfer-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaUpload, type MediaUploadKind, type MediaUploadStatus } from '../../domain/media-transfer.ts'

export class PrismaMediaTransferRepository implements MediaTransferRepository {
  constructor(private readonly client: PrismaClient) {}

  async createOrReplayUpload(record: Parameters<MediaTransferRepository['createOrReplayUpload']>[0]) {
    return this.client.$transaction(async (tx) => {
      const existing = await tx.v2MediaUpload.findUnique({
        where: { workspaceId_clientId_idempotencyKey: {
          workspaceId: record.upload.workspaceId, clientId: record.upload.clientId, idempotencyKey: record.idempotencyKey,
        } },
      })
      if (existing) {
        if (existing.requestFingerprint !== record.requestFingerprint) {
          throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency-Key was already used with a different upload intent')
        }
        return { upload: createMediaUpload({
          id: existing.id, workspaceId: existing.workspaceId, clientId: existing.clientId,
          kind: existing.kind as MediaUploadKind, byteSize: existing.byteSize.toString(), mimeType: existing.mimeType,
          expectedSha256: existing.expectedSha256, status: existing.status as MediaUploadStatus,
          expiresAt: existing.expiresAt.toISOString(), createdAt: existing.createdAt.toISOString(),
        }), replayed: true }
      }
      const created = await tx.v2MediaUpload.create({ data: {
        id: record.upload.id, workspaceId: record.upload.workspaceId, clientId: record.upload.clientId,
        kind: record.upload.kind, byteSize: BigInt(record.upload.byteSize), mimeType: record.upload.mimeType,
        expectedSha256: record.upload.expectedSha256, status: record.upload.status,
        idempotencyKey: record.idempotencyKey, requestFingerprint: record.requestFingerprint,
        expiresAt: new Date(record.upload.expiresAt), createdAt: new Date(record.upload.createdAt),
      } })
      return { upload: createMediaUpload({
        id: created.id, workspaceId: created.workspaceId, clientId: created.clientId,
        kind: created.kind as MediaUploadKind, byteSize: created.byteSize.toString(), mimeType: created.mimeType,
        expectedSha256: created.expectedSha256, status: created.status as MediaUploadStatus,
        expiresAt: created.expiresAt.toISOString(), createdAt: created.createdAt.toISOString(),
      }), replayed: false }
    })
  }

  private present(row: {
    id: string; workspaceId: string; clientId: string; kind: string; byteSize: bigint; mimeType: string;
    expectedSha256: string; status: string; expiresAt: Date; createdAt: Date;
    sessionMode: string | null; partSize: bigint | null; sessionExpiresAt: Date | null;
  }) {
    return createMediaUpload({
      id: row.id, workspaceId: row.workspaceId, clientId: row.clientId,
      kind: row.kind as MediaUploadKind, byteSize: row.byteSize.toString(), mimeType: row.mimeType,
      expectedSha256: row.expectedSha256, status: row.status as MediaUploadStatus,
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
      ...(row.sessionMode ? { sessionMode: row.sessionMode as 'single' | 'multipart' } : {}),
      ...(row.partSize ? { partSize: row.partSize.toString() } : {}),
      ...(row.sessionExpiresAt ? { sessionExpiresAt: row.sessionExpiresAt.toISOString() } : {}),
    })
  }

  async findUpload(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const row = await this.client.v2MediaUpload.findFirst({ where: {
      id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId,
    } })
    return row ? this.present(row) : undefined
  }

  async markSessionIssued(input: {
    workspaceId: string; clientId: string; uploadId: string; mode: 'single' | 'multipart';
    partSize?: string; sessionExpiresAt: string;
  }) {
    const updated = await this.client.v2MediaUpload.updateMany({
      where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: { in: ['pending-session', 'uploading'] } },
      data: {
        status: 'uploading', sessionMode: input.mode,
        partSize: input.partSize ? BigInt(input.partSize) : null,
        sessionExpiresAt: new Date(input.sessionExpiresAt),
      },
    })
    if (updated.count !== 1) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot issue a signed session in its current state')
    const row = await this.client.v2MediaUpload.findFirstOrThrow({ where: {
      id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId,
    } })
    return this.present(row)
  }
}
