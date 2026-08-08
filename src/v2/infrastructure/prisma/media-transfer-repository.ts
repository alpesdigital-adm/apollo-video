import { randomUUID } from 'node:crypto'
import type {
  PrismaClient,
  V2MediaUpload,
  V2MediaUploadAuditEntry,
} from '../../../../generated/prisma-v2/index.js'

import type { MediaTransferRepository } from '../../application/ports/media-transfer-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaUpload, createMediaUploadPart, type MediaUploadKind, type MediaUploadStatus } from '../../domain/media-transfer.ts'
import {
  createMediaUploadAuditEntry,
  type MediaUploadAuditEntry,
} from '../../domain/media-upload-audit-entry.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'

function auditEntryData(entry: Readonly<MediaUploadAuditEntry>) {
  return {
    id: entry.id, workspaceId: entry.workspaceId, uploadId: entry.uploadId,
    action: entry.action, partNumber: entry.partNumber,
    actorClientId: entry.audit.clientId,
    actorCredentialId: entry.audit.credentialId,
    actorEnvironment: entry.audit.environment,
    actorAuthenticationKind: entry.audit.authenticationKind,
    actorContextHash: entry.audit.contextHash,
    delegatedUserId: entry.audit.delegatedUserId,
    delegatedIdentityId: entry.audit.delegatedIdentityId,
    workspaceRole: entry.audit.workspaceRole,
    requestFingerprint: entry.requestFingerprint,
    occurredAt: new Date(entry.occurredAt),
  }
}

function hydrateAuditEntry(row: V2MediaUploadAuditEntry) {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.actorClientId, credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId, environment: row.actorEnvironment as ApiEnvironment,
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
      ...(row.delegatedIdentityId ? { delegatedIdentityId: row.delegatedIdentityId } : {}),
      ...(row.workspaceRole ? { workspaceRole: row.workspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('context hash mismatch')
    return createMediaUploadAuditEntry({
      id: row.id, workspaceId: row.workspaceId, uploadId: row.uploadId,
      action: row.action as MediaUploadAuditEntry['action'],
      ...(row.partNumber === null ? {} : { partNumber: row.partNumber }),
      audit, requestFingerprint: row.requestFingerprint, occurredAt: row.occurredAt.toISOString(),
    })
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media upload audit entry is invalid', { auditEntryId: row.id })
  }
}

function assertAuditEntryMatches(
  row: V2MediaUploadAuditEntry | null,
  expected: Readonly<MediaUploadAuditEntry>,
): V2MediaUploadAuditEntry {
  if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Media upload audit entry is missing')
  const hydrated = hydrateAuditEntry(row)
  if (
    hydrated.action !== expected.action || hydrated.uploadId !== expected.uploadId ||
    hydrated.workspaceId !== expected.workspaceId || hydrated.partNumber !== expected.partNumber ||
    hydrated.requestFingerprint !== expected.requestFingerprint ||
    hydrated.audit.contextHash !== expected.audit.contextHash
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Media upload audit replay is mismatched')
  }
  return row
}

export class PrismaMediaTransferRepository implements MediaTransferRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

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
        const auditEntry = await tx.v2MediaUploadAuditEntry.findFirst({
          where: { workspaceId: existing.workspaceId, uploadId: existing.id, action: 'begin' },
        })
        assertAuditEntryMatches(auditEntry, { ...record.auditEntry, uploadId: existing.id })
        return { upload: this.present(existing), replayed: true }
      }
      if (record.upload.projectId) {
        const project = await tx.v2Project.findFirst({
          where: { id: record.upload.projectId, workspaceId: record.upload.workspaceId },
          select: { id: true },
        })
        if (!project) throw new DomainError('INVALID_ARGUMENT', 'Upload project was not found in this workspace')
      }
      const created = await tx.v2MediaUpload.create({ data: {
        id: record.upload.id, workspaceId: record.upload.workspaceId, clientId: record.upload.clientId,
        projectId: record.upload.projectId ?? null,
        fileName: record.upload.fileName ?? null,
        rightsConfirmed: record.upload.rightsConfirmed ?? false,
        kind: record.upload.kind, byteSize: BigInt(record.upload.byteSize), mimeType: record.upload.mimeType,
        expectedSha256: record.upload.expectedSha256, status: record.upload.status,
        idempotencyKey: record.idempotencyKey, requestFingerprint: record.requestFingerprint,
        expiresAt: new Date(record.upload.expiresAt), createdAt: new Date(record.upload.createdAt),
      } })
      await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(record.auditEntry) })
      return { upload: this.present(created), replayed: false }
    })
  }

  private present(row: V2MediaUpload) {
    try {
      const probe = row.probeJson ? JSON.parse(row.probeJson) as NonNullable<ReturnType<typeof createMediaUpload>['probe']> : undefined
      const inspectionError = row.inspectionErrorJson ? JSON.parse(row.inspectionErrorJson) as NonNullable<ReturnType<typeof createMediaUpload>['inspectionError']> : undefined
      return createMediaUpload({
        id: row.id, workspaceId: row.workspaceId, clientId: row.clientId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.fileName ? { fileName: row.fileName } : {}),
        rightsConfirmed: row.rightsConfirmed,
        kind: row.kind as MediaUploadKind, byteSize: row.byteSize.toString(), mimeType: row.mimeType,
        expectedSha256: row.expectedSha256, status: row.status as MediaUploadStatus,
        expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
        ...(row.sessionMode ? { sessionMode: row.sessionMode as 'single' | 'multipart' } : {}),
        ...(row.partSize ? { partSize: row.partSize.toString() } : {}),
        ...(row.sessionExpiresAt ? { sessionExpiresAt: row.sessionExpiresAt.toISOString() } : {}),
        ...(row.actualSha256 ? { actualSha256: row.actualSha256 } : {}),
        ...(row.actualByteSize ? { actualByteSize: row.actualByteSize.toString() } : {}),
        ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
        inspectionStatus: row.inspectionStatus as 'pending' | 'usable' | 'quarantined',
        ...(row.detectedMimeType ? { detectedMimeType: row.detectedMimeType } : {}),
        ...(row.detectedExtension ? { detectedExtension: row.detectedExtension } : {}),
        ...(probe ? { probe } : {}),
        ...(inspectionError ? { inspectionError } : {}),
        ...(row.inspectedAt ? { inspectedAt: row.inspectedAt.toISOString() } : {}),
      })
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media upload inspection evidence is invalid', { uploadId: row.id })
    }
  }

  async findUpload(input: { workspaceId: string; clientId: string; uploadId: string }) {
    const row = await this.client.v2MediaUpload.findFirst({ where: {
      id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId,
    } })
    if (!row) return undefined
    const beginAudit = await this.client.v2MediaUploadAuditEntry.findFirst({
      where: { workspaceId: input.workspaceId, uploadId: input.uploadId, action: 'begin' },
    })
    if (!beginAudit) throw new DomainError('PERSISTENCE_CONFLICT', 'Media upload predates the required audit contract')
    hydrateAuditEntry(beginAudit)
    return this.present(row)
  }

  async markSessionIssued(input: {
    workspaceId: string; clientId: string; uploadId: string; mode: 'single' | 'multipart';
    partSize?: string; sessionExpiresAt: string;
    auditEntry: Readonly<MediaUploadAuditEntry>;
  }) {
    return this.client.$transaction(async (tx) => {
      const existingAudit = await tx.v2MediaUploadAuditEntry.findFirst({ where: {
        uploadId: input.uploadId, action: 'session-issue', requestFingerprint: input.auditEntry.requestFingerprint,
      } })
      const auditId = existingAudit
        ? assertAuditEntryMatches(existingAudit, input.auditEntry).id
        : (await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(input.auditEntry) })).id
      const updated = await tx.v2MediaUpload.updateMany({
        where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: { in: ['pending-session', 'uploading'] } },
        data: {
          status: 'uploading', sessionMode: input.mode,
          partSize: input.partSize ? BigInt(input.partSize) : null,
          sessionExpiresAt: new Date(input.sessionExpiresAt), sessionAuditEntryId: auditId,
        },
      })
      if (updated.count !== 1) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot issue a signed session in its current state')
      const row = await tx.v2MediaUpload.findFirstOrThrow({ where: {
        id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId,
      } })
      return this.present(row)
    })
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

  async recordUploadPart(input: { workspaceId: string; clientId: string; part: ReturnType<typeof createMediaUploadPart>; auditEntry: Readonly<MediaUploadAuditEntry> }) {
    return this.client.$transaction(async (tx) => {
      const upload = await tx.v2MediaUpload.findFirst({ where: { id: input.part.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'uploading' } })
      if (!upload) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot accept parts')
      const existingAudit = await tx.v2MediaUploadAuditEntry.findFirst({ where: {
        uploadId: input.part.uploadId, action: 'part-record', requestFingerprint: input.auditEntry.requestFingerprint,
      } })
      if (existingAudit) assertAuditEntryMatches(existingAudit, input.auditEntry)
      const row = await tx.v2MediaUploadPart.upsert({
      where: { uploadId_partNumber: { uploadId: input.part.uploadId, partNumber: input.part.partNumber } },
      create: { id: randomUUID(), workspaceId: input.workspaceId, uploadId: input.part.uploadId, partNumber: input.part.partNumber, byteSize: BigInt(input.part.byteSize), etag: input.part.etag, checksum: input.part.checksum, recordedAt: new Date(input.part.recordedAt) },
      update: { byteSize: BigInt(input.part.byteSize), etag: input.part.etag, checksum: input.part.checksum, recordedAt: new Date(input.part.recordedAt) },
      })
      if (!existingAudit) await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(input.auditEntry) })
      return createMediaUploadPart({ uploadId: row.uploadId, partNumber: row.partNumber, byteSize: row.byteSize.toString(), etag: row.etag, checksum: row.checksum, recordedAt: row.recordedAt.toISOString() })
    })
  }

  async markUploadVerifiedOrReplay(input: Parameters<MediaTransferRepository['markUploadVerifiedOrReplay']>[0]) {
    return this.client.$transaction(async (tx) => {
      const current = await tx.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      if (!current) throw new DomainError('MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
      if (current.status === 'verified') {
        const existingAudit = await tx.v2MediaUploadAuditEntry.findFirst({ where: { uploadId: input.uploadId, action: 'complete' } })
        assertAuditEntryMatches(existingAudit, input.auditEntry)
        return { upload: this.present(current), replayed: true }
      }
      const updated = await tx.v2MediaUpload.updateMany({
        where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'uploading' },
        data: { status: 'verified', actualByteSize: BigInt(input.actualByteSize), actualSha256: input.actualSha256, verifiedAt: new Date(input.verifiedAt) },
      })
      if (updated.count !== 1) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot be completed')
      await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(input.auditEntry) })
      const row = await tx.v2MediaUpload.findFirstOrThrow({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      return { upload: this.present(row), replayed: false }
    })
  }

  async markUploadAbortedOrReplay(input: Parameters<MediaTransferRepository['markUploadAbortedOrReplay']>[0]) {
    return this.client.$transaction(async (tx) => {
      const current = await tx.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      if (!current) throw new DomainError('MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
      if (current.status === 'aborted') {
        const existingAudit = await tx.v2MediaUploadAuditEntry.findFirst({ where: { uploadId: input.uploadId, action: 'abort' } })
        assertAuditEntryMatches(existingAudit, input.auditEntry)
        return { upload: this.present(current), replayed: true }
      }
      const updated = await tx.v2MediaUpload.updateMany({
        where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: { in: ['pending-session', 'uploading'] } },
        data: { status: 'aborted' },
      })
      if (updated.count !== 1) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload cannot be aborted')
      await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(input.auditEntry) })
      const row = await tx.v2MediaUpload.findFirstOrThrow({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      return { upload: this.present(row), replayed: false }
    })
  }

  async recordUploadInspection(input: Parameters<MediaTransferRepository['recordUploadInspection']>[0]) {
    return this.client.$transaction(async (tx) => {
      const current = await tx.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      if (!current) throw new DomainError('MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
      const probeJson = input.probe ? stableSerialize(input.probe) : null
      const inspectionErrorJson = input.error ? stableSerialize(input.error) : null
      if (current.inspectionStatus !== 'pending') {
        const existingAudit = await tx.v2MediaUploadAuditEntry.findFirst({ where: { uploadId: input.uploadId, action: 'inspect' } })
        assertAuditEntryMatches(existingAudit, input.auditEntry)
        if (
          current.inspectionStatus !== input.status || current.detectedMimeType !== (input.detectedMimeType ?? null) ||
          current.detectedExtension !== (input.detectedExtension ?? null) || current.probeJson !== probeJson ||
          current.inspectionErrorJson !== inspectionErrorJson || current.inspectedAt?.toISOString() !== new Date(input.inspectedAt).toISOString()
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Media inspection replay is mismatched')
        return { upload: this.present(current), replayed: true }
      }
      if (current.status !== 'verified') throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Only a verified upload can be inspected')
      const updated = await tx.v2MediaUpload.updateMany({
        where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'verified', inspectionStatus: 'pending' },
        data: {
          inspectionStatus: input.status, detectedMimeType: input.detectedMimeType ?? null,
          detectedExtension: input.detectedExtension ?? null, probeJson,
          inspectionErrorJson, inspectedAt: new Date(input.inspectedAt),
        },
      })
      if (updated.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Media inspection lost its compare-and-set fence')
      await tx.v2MediaUploadAuditEntry.create({ data: auditEntryData(input.auditEntry) })
      const row = await tx.v2MediaUpload.findFirstOrThrow({ where: { id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId } })
      return { upload: this.present(row), replayed: false }
    })
  }

  async findCurrentUploadSessionAudit(input: Parameters<MediaTransferRepository['findCurrentUploadSessionAudit']>[0]) {
    const upload = await this.client.v2MediaUpload.findFirst({ where: {
      id: input.uploadId, workspaceId: input.workspaceId, clientId: input.clientId,
      sessionExpiresAt: new Date(input.sessionExpiresAt),
    }, select: { sessionAuditEntryId: true } })
    if (!upload?.sessionAuditEntryId) return undefined
    const row = await this.client.v2MediaUploadAuditEntry.findFirst({ where: {
      id: upload.sessionAuditEntryId, workspaceId: input.workspaceId,
      uploadId: input.uploadId, action: 'session-issue',
    } })
    if (!row) return undefined
    const audit = hydrateAuditEntry(row).audit
    if (audit.clientId !== input.clientId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Signed upload session audit client is mismatched')
    }
    return audit
  }
}
