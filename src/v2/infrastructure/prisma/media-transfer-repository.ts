import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

import type { MediaTransferRepository } from '../../application/ports/media-transfer-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaUpload, createMediaUploadPart, type MediaUploadKind, type MediaUploadStatus } from '../../domain/media-transfer.ts'

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
    actualSha256: string | null; actualByteSize: bigint | null; verifiedAt: Date | null;
  }) {
    return createMediaUpload({
      id: row.id, workspaceId: row.workspaceId, clientId: row.clientId,
      kind: row.kind as MediaUploadKind, byteSize: row.byteSize.toString(), mimeType: row.mimeType,
      expectedSha256: row.expectedSha256, status: row.status as MediaUploadStatus,
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
      ...(row.sessionMode ? { sessionMode: row.sessionMode as 'single' | 'multipart' } : {}),
      ...(row.partSize ? { partSize: row.partSize.toString() } : {}),
      ...(row.sessionExpiresAt ? { sessionExpiresAt: row.sessionExpiresAt.toISOString() } : {}),
      ...(row.actualSha256 ? { actualSha256: row.actualSha256 } : {}),
      ...(row.actualByteSize ? { actualByteSize: row.actualByteSize.toString() } : {}),
      ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
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

  async listUploadParts(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const upload = await this.client.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId }, select: { id: true } })
    if (!upload) throw new DomainError('MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
    const rows = await this.client.v2MediaUploadPart.findMany({ where: { workspaceId: input.workspaceId, uploadId: input.uploadId }, orderBy: { partNumber: 'asc' } })
    return Object.freeze(rows.map((row) => createMediaUploadPart({
      uploadId: row.uploadId, partNumber: row.partNumber, byteSize: row.byteSize.toString(),
      etag: row.etag, checksum: row.checksum, recordedAt: row.recordedAt.toISOString(),
    })))
  }

  async recordUploadPart(input: { workspaceId: string; clientId: string; part: ReturnType<typeof createMediaUploadPart> }) {
    const upload = await this.client.v2MediaUpload.findFirst({ where: { id: input.part.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'uploading' } })
    if (!upload) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot accept parts')
    const row = await this.client.v2MediaUploadPart.upsert({
      where: { uploadId_partNumber: { uploadId: input.part.uploadId, partNumber: input.part.partNumber } },
      create: { id: randomUUID(), workspaceId: input.workspaceId, uploadId: input.part.uploadId, partNumber: input.part.partNumber, byteSize: BigInt(input.part.byteSize), etag: input.part.etag, checksum: input.part.checksum, recordedAt: new Date(input.part.recordedAt) },
      update: { byteSize: BigInt(input.part.byteSize), etag: input.part.etag, checksum: input.part.checksum, recordedAt: new Date(input.part.recordedAt) },
    })
    return createMediaUploadPart({ uploadId: row.uploadId, partNumber: row.partNumber, byteSize: row.byteSize.toString(), etag: row.etag, checksum: row.checksum, recordedAt: row.recordedAt.toISOString() })
  }

  async markUploadVerified(input: { workspaceId: string; clientId: string; uploadId: string; actualByteSize: string; actualSha256: string; verifiedAt: string }) {
    const updated = await this.client.v2MediaUpload.updateMany({
      where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'uploading' },
      data: { status: 'verified', actualByteSize: BigInt(input.actualByteSize), actualSha256: input.actualSha256, verifiedAt: new Date(input.verifiedAt) },
    })
    if (updated.count !== 1) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot be completed')
    const row = await this.client.v2MediaUpload.findFirstOrThrow({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
    return this.present(row)
  }
}
