import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { AutomaticCatalogRepository } from '../../application/ports/automatic-catalog-repository.ts'
import {
  assertAutomaticCatalogCandidate,
  automaticCatalogRecordHash,
  type AutomaticCatalogCandidate,
  type AutomaticCatalogLineage,
  type AutomaticCatalogOutputKind,
  type AutomaticCatalogRecord,
} from '../../domain/automatic-catalog.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'

function parseValidators(value: string): readonly { code: string; passed: boolean; message: string }[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'object' && item !== null && typeof (item as { code?: unknown }).code === 'string' && typeof (item as { passed?: unknown }).passed === 'boolean')) throw new Error('invalid')
    return parsed as readonly { code: string; passed: boolean; message: string }[]
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export validators are invalid')
  }
}

function parseLineage(value: string): readonly AutomaticCatalogLineage[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return Object.freeze(parsed.map((edge, ordinal) => {
      if (typeof edge !== 'object' || edge === null) throw new Error('invalid')
      const item = edge as Record<string, unknown>
      if (typeof item.sourceArtifactId !== 'string' || typeof item.role !== 'string' || item.ordinal !== ordinal) throw new Error('invalid')
      return Object.freeze(item) as unknown as AutomaticCatalogLineage
    }))
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored automatic catalog lineage is invalid')
  }
}

function catalogId(workspaceId: string, artifactId: string, manifestId: string): string {
  return `catalog-${createHash('sha256').update(`${workspaceId}:${artifactId}:${manifestId}`).digest('hex').slice(0, 48)}`
}

export class PrismaAutomaticCatalogRepository implements AutomaticCatalogRepository {
  constructor(private readonly client: PrismaClient) {}

  async find(workspaceId: string, artifactId: string): Promise<AutomaticCatalogRecord | null> {
    const row = await this.client.v2AutomaticCatalogRecord.findFirst({ where: { workspaceId, artifactId }, orderBy: { createdAt: 'desc' } })
    if (!row) return null
    const lineage = parseLineage(row.lineageJson)
    const record: AutomaticCatalogRecord = Object.freeze({
      id: row.id, workspaceId: row.workspaceId, artifactId: row.artifactId, manifestId: row.manifestId,
      outputKind: row.outputKind as AutomaticCatalogOutputKind, searchableKind: row.searchableKind as 'asset' | 'segment',
      ...(row.segmentId ? { segmentId: row.segmentId } : {}), rightsSnapshotId: row.rightsSnapshotId,
      rightsSnapshotHash: row.rightsSnapshotHash, eligibilityEvidenceHash: row.eligibilityEvidenceHash,
      lineage, recordHash: row.recordHash, createdAt: row.createdAt.toISOString(),
    })
    const expected = automaticCatalogRecordHash({
      workspaceId: record.workspaceId, artifactId: record.artifactId, manifestId: record.manifestId,
      outputKind: record.outputKind, searchableKind: record.searchableKind, ...(record.segmentId ? { segmentId: record.segmentId } : {}),
      rightsSnapshotId: record.rightsSnapshotId, rightsSnapshotHash: record.rightsSnapshotHash,
      eligibilityEvidenceHash: record.eligibilityEvidenceHash, lineage: record.lineage,
    })
    if (expected !== row.recordHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored automatic catalog record hash is invalid')
    return record
  }

  async inspect(target: { workspaceId: string; artifactId: string; manifestId: string }): Promise<AutomaticCatalogCandidate | null> {
    const manifest = await this.client.v2MediaArtifactManifest.findFirst({
      where: { id: target.manifestId, artifactId: target.artifactId, workspaceId: target.workspaceId },
      include: {
        artifact: { select: { status: true } },
        lineageEdges: { orderBy: { ordinal: 'asc' } },
      },
    })
    if (!manifest || manifest.artifact.status !== 'available') return null
    let outputKind: AutomaticCatalogOutputKind
    let eligibilityEvidenceHash: string
    if (manifest.recipeId === 'editorial-proxy') {
      const review = await this.client.v2ProxyReview.findFirst({
        where: { workspaceId: target.workspaceId, proxyArtifactId: target.artifactId, proxyManifestId: target.manifestId },
        select: { status: true, finalAllowed: true, reviewHash: true },
      })
      if (!review || review.status !== 'ready-for-final' || !review.finalAllowed) return null
      outputKind = 'proxy'
      eligibilityEvidenceHash = calculateCanonicalHash({ schemaVersion: 'automatic-catalog-eligibility/v1', outputKind, reviewHash: review.reviewHash })
    } else if (manifest.recipeId === 'editorial-final') {
      const attempt = await this.client.v2ProjectFinalExportAttempt.findFirst({
        where: { workspaceId: target.workspaceId, outputArtifactId: target.artifactId, outputManifestId: target.manifestId, status: 'promoted' },
        orderBy: [{ completedAt: 'desc' }, { attempt: 'desc' }],
        select: { operationId: true, attempt: true, validatorsJson: true, outputSha256: true, outputByteSize: true },
      })
      if (!attempt) return null
      const validators = parseValidators(attempt.validatorsJson)
      if (validators.length === 0 || validators.some((validator) => !validator.passed)) return null
      outputKind = 'final'
      eligibilityEvidenceHash = calculateCanonicalHash({
        schemaVersion: 'automatic-catalog-eligibility/v1', outputKind,
        operationId: attempt.operationId, attempt: attempt.attempt, validators,
        outputSha256: attempt.outputSha256, outputByteSize: attempt.outputByteSize?.toString() ?? null,
      })
    } else {
      // There is no durable deepfake promotion/approval aggregate in the current runtime.
      // Unknown, temporary and failed recipes are deliberately not inferred as eligible.
      return null
    }
    const lineage = Object.freeze(manifest.lineageEdges.map((edge) => Object.freeze({
      sourceArtifactId: edge.sourceArtifactId,
      role: edge.role,
      ordinal: edge.ordinal,
      ...(edge.modelProvider ? { provider: edge.modelProvider } : {}),
      ...(edge.modelId ? { model: edge.modelId } : {}),
      ...(edge.modelVersion ? { modelVersion: edge.modelVersion } : {}),
    })))
    const projectAsset = await this.client.v2ProjectMediaAsset.findFirst({
      where: { workspaceId: target.workspaceId, artifactId: target.artifactId },
      orderBy: { createdAt: 'desc' },
      select: { originalFileName: true },
    })
    const candidate: AutomaticCatalogCandidate = Object.freeze({
      workspaceId: target.workspaceId,
      artifactId: target.artifactId,
      manifestId: target.manifestId,
      outputKind,
      searchableKind: 'asset',
      label: projectAsset?.originalFileName ?? `${outputKind}-${target.artifactId}`,
      eligibilityEvidenceHash,
      lineage,
    })
    assertAutomaticCatalogCandidate(candidate)
    return candidate
  }

  async persist(input: { candidate: AutomaticCatalogCandidate; rightsSnapshotId: string; rightsSnapshotHash: string; createdAt: string }) {
    assertAutomaticCatalogCandidate(input.candidate)
    const fresh = await this.inspect(input.candidate)
    if (!fresh || fresh.eligibilityEvidenceHash !== input.candidate.eligibilityEvidenceHash || stableSerialize(fresh.lineage) !== stableSerialize(input.candidate.lineage)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog output eligibility changed before persistence')
    }
    const segmentId = input.candidate.searchableKind === 'segment'
      ? `catalog-segment-${createHash('sha256').update(`${input.candidate.workspaceId}:${input.candidate.artifactId}:${input.candidate.manifestId}`).digest('hex').slice(0, 40)}`
      : undefined
    const recordData = {
      workspaceId: input.candidate.workspaceId,
      artifactId: input.candidate.artifactId,
      manifestId: input.candidate.manifestId,
      outputKind: input.candidate.outputKind,
      searchableKind: input.candidate.searchableKind,
      ...(segmentId ? { segmentId } : {}),
      rightsSnapshotId: input.rightsSnapshotId,
      rightsSnapshotHash: input.rightsSnapshotHash,
      eligibilityEvidenceHash: input.candidate.eligibilityEvidenceHash,
      lineage: input.candidate.lineage,
    } as const
    const recordHash = automaticCatalogRecordHash(recordData)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
          const [rights, existing] = await Promise.all([
            transaction.v2MediaArtifact.findFirst({ where: { id: input.candidate.artifactId, workspaceId: input.candidate.workspaceId }, select: { currentRightsSnapshotId: true, currentRightsSnapshot: { select: { snapshotHash: true } } } }),
            transaction.v2AutomaticCatalogRecord.findUnique({ where: { workspaceId_artifactId_manifestId: { workspaceId: input.candidate.workspaceId, artifactId: input.candidate.artifactId, manifestId: input.candidate.manifestId } } }),
          ])
          if (!rights || rights.currentRightsSnapshotId !== input.rightsSnapshotId || rights.currentRightsSnapshot?.snapshotHash !== input.rightsSnapshotHash) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Catalog output rights evidence changed before persistence')
          if (input.candidate.searchableKind === 'asset') {
            const prior = await transaction.v2MediaLibraryEntry.findUnique({ where: { artifactId: input.candidate.artifactId } })
            if (prior && (prior.workspaceId !== input.candidate.workspaceId || prior.originType !== 'generated')) throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog output conflicts with an existing library entry')
            if (!prior) await transaction.v2MediaLibraryEntry.create({ data: {
              artifactId: input.candidate.artifactId, workspaceId: input.candidate.workspaceId,
              label: input.candidate.label, peopleJson: '[]', peopleSearch: '\n', topicsJson: '[]', topicsSearch: '\n',
              originType: 'generated', parentArtifactId: input.candidate.lineage.length === 1 ? input.candidate.lineage[0].sourceArtifactId : null,
              createdAt: new Date(input.createdAt), updatedAt: new Date(input.createdAt),
            } })
          } else {
            const duration = input.candidate.sourceDurationMs!
            const segmentHash = calculateCanonicalHash({ schemaVersion: 'media-segment/v1', artifactId: input.candidate.artifactId, parentSegmentId: null, label: input.candidate.label, description: '', startMs: 0, endMs: duration, sourceDurationMs: duration })
            const prior = await transaction.v2MediaSegment.findUnique({ where: { id: segmentId! } })
            if (prior && (prior.workspaceId !== input.candidate.workspaceId || prior.segmentHash !== segmentHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog output conflicts with an existing segment')
            if (!prior) await transaction.v2MediaSegment.create({ data: { id: segmentId!, workspaceId: input.candidate.workspaceId, artifactId: input.candidate.artifactId, label: input.candidate.label, description: '', startMs: 0, endMs: duration, sourceDurationMs: duration, segmentHash, createdAt: new Date(input.createdAt) } })
          }
          const row = existing ?? await transaction.v2AutomaticCatalogRecord.create({ data: {
            id: catalogId(input.candidate.workspaceId, input.candidate.artifactId, input.candidate.manifestId),
            workspaceId: input.candidate.workspaceId, artifactId: input.candidate.artifactId, manifestId: input.candidate.manifestId,
            outputKind: input.candidate.outputKind, searchableKind: input.candidate.searchableKind, segmentId: segmentId ?? null,
            rightsSnapshotId: input.rightsSnapshotId, rightsSnapshotHash: input.rightsSnapshotHash,
            eligibilityEvidenceHash: input.candidate.eligibilityEvidenceHash, lineageJson: stableSerialize(input.candidate.lineage), recordHash,
            createdAt: new Date(input.createdAt),
          } })
          if (row.recordHash !== recordHash || row.rightsSnapshotHash !== input.rightsSnapshotHash || row.eligibilityEvidenceHash !== input.candidate.eligibilityEvidenceHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored automatic catalog record conflicts with this output')
          const lineage = parseLineage(row.lineageJson)
          const record: AutomaticCatalogRecord = Object.freeze({
            id: row.id, workspaceId: row.workspaceId, artifactId: row.artifactId, manifestId: row.manifestId,
            outputKind: row.outputKind as AutomaticCatalogOutputKind, searchableKind: row.searchableKind as 'asset' | 'segment',
            ...(row.segmentId ? { segmentId: row.segmentId } : {}), rightsSnapshotId: row.rightsSnapshotId,
            rightsSnapshotHash: row.rightsSnapshotHash, eligibilityEvidenceHash: row.eligibilityEvidenceHash,
            lineage, recordHash: row.recordHash, createdAt: row.createdAt.toISOString(),
          })
          const expectedHash = automaticCatalogRecordHash({ workspaceId: record.workspaceId, artifactId: record.artifactId, manifestId: record.manifestId, outputKind: record.outputKind, searchableKind: record.searchableKind, ...(record.segmentId ? { segmentId: record.segmentId } : {}), rightsSnapshotId: record.rightsSnapshotId, rightsSnapshotHash: record.rightsSnapshotHash, eligibilityEvidenceHash: record.eligibilityEvidenceHash, lineage: record.lineage })
          if (expectedHash !== row.recordHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored automatic catalog record hash is invalid')
          return Object.freeze({ record, replayed: existing !== null })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (attempt < 3 && (code === 'P2034' || code === 'P2002')) continue
        throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Automatic catalog persistence could not be serialized')
  }
}
