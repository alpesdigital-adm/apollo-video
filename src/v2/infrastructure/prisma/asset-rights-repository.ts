import { Prisma, type PrismaClient, type V2AssetRightsSnapshot } from '../../../../generated/prisma-v2/index.js'

import type {
  AssetRightsRecord,
  AssetRightsRepository,
  SetAssetRightsResult,
} from '../../application/ports/asset-rights-repository.ts'
import {
  assetRightsRevision,
  createAssetRightsSnapshot,
  type AssetRightsDraft,
  type AssetRightsSnapshot,
  type AssetRightsStatus,
  type AssetConsentStatus,
} from '../../domain/asset-rights.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function isSerializationConflict(error: unknown): error is { code: 'P2034' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function parseStringArray(value: string | null, field: string): readonly string[] | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('invalid array')
    }
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function draftFromSnapshot(snapshot: AssetRightsSnapshot): AssetRightsDraft {
  return {
    ...(snapshot.owner ? { owner: snapshot.owner } : {}),
    ...(snapshot.license ? { license: snapshot.license } : {}),
    status: snapshot.status,
    allowedUses: snapshot.allowedUses,
    prohibitedUses: snapshot.prohibitedUses,
    ...(snapshot.allowedMarkets ? { allowedMarkets: snapshot.allowedMarkets } : {}),
    ...(snapshot.allowedLocales ? { allowedLocales: snapshot.allowedLocales } : {}),
    ...(snapshot.allowedSyntheticOperations
      ? { allowedSyntheticOperations: snapshot.allowedSyntheticOperations }
      : {}),
    ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
    consent: {
      status: snapshot.consent.status,
      allowedUses: snapshot.consent.allowedUses,
      ...(snapshot.consent.allowedMarkets
        ? { allowedMarkets: snapshot.consent.allowedMarkets }
        : {}),
      ...(snapshot.consent.allowedLocales
        ? { allowedLocales: snapshot.consent.allowedLocales }
        : {}),
      ...(snapshot.consent.allowedSyntheticOperations
        ? { allowedSyntheticOperations: snapshot.consent.allowedSyntheticOperations }
        : {}),
      ...(snapshot.consent.expiresAt ? { expiresAt: snapshot.consent.expiresAt } : {}),
      ...(snapshot.consent.documentArtifactId
        ? { documentArtifactId: snapshot.consent.documentArtifactId }
        : {}),
    },
    ...(snapshot.sourceNote ? { sourceNote: snapshot.sourceNote } : {}),
  }
}

function hydrateRights(row: V2AssetRightsSnapshot): AssetRightsSnapshot {
  const snapshot = createAssetRightsSnapshot({
    id: row.id,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    sequence: row.sequence,
    draft: {
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.license ? { license: row.license } : {}),
      status: row.status as AssetRightsStatus,
      allowedUses: parseStringArray(row.allowedUsesJson, 'allowedUsesJson') ?? [],
      prohibitedUses: parseStringArray(row.prohibitedUsesJson, 'prohibitedUsesJson') ?? [],
      ...(row.allowedMarketsJson !== null
        ? { allowedMarkets: parseStringArray(row.allowedMarketsJson, 'allowedMarketsJson') ?? [] }
        : {}),
      ...(row.allowedLocalesJson !== null
        ? { allowedLocales: parseStringArray(row.allowedLocalesJson, 'allowedLocalesJson') ?? [] }
        : {}),
      ...(row.allowedSyntheticOperationsJson !== null
        ? {
            allowedSyntheticOperations:
              parseStringArray(
                row.allowedSyntheticOperationsJson,
                'allowedSyntheticOperationsJson',
              ) ?? [],
          }
        : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      consent: {
        status: row.consentStatus as AssetConsentStatus,
        allowedUses:
          parseStringArray(row.consentAllowedUsesJson, 'consentAllowedUsesJson') ?? [],
        ...(row.consentAllowedMarketsJson !== null
          ? {
              allowedMarkets:
                parseStringArray(row.consentAllowedMarketsJson, 'consentAllowedMarketsJson') ?? [],
            }
          : {}),
        ...(row.consentAllowedLocalesJson !== null
          ? {
              allowedLocales:
                parseStringArray(row.consentAllowedLocalesJson, 'consentAllowedLocalesJson') ?? [],
            }
          : {}),
        ...(row.consentSyntheticOperationsJson !== null
          ? {
              allowedSyntheticOperations:
                parseStringArray(
                  row.consentSyntheticOperationsJson,
                  'consentSyntheticOperationsJson',
                ) ?? [],
            }
          : {}),
        ...(row.consentExpiresAt
          ? { expiresAt: row.consentExpiresAt.toISOString() }
          : {}),
        ...(row.consentDocumentArtifactId
          ? { documentArtifactId: row.consentDocumentArtifactId }
          : {}),
      },
      ...(row.sourceNote ? { sourceNote: row.sourceNote } : {}),
    },
    createdBy: {
      type: row.createdByType as AssetRightsSnapshot['createdBy']['type'],
      id: row.createdById,
    },
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.schemaVersion !== snapshot.schemaVersion ||
    row.snapshotHash !== snapshot.snapshotHash ||
    (parseStringArray(row.allowedWorkspaceIdsJson, 'allowedWorkspaceIdsJson') ?? []).join('\n') !==
      snapshot.allowedWorkspaceIds.join('\n')
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored rights snapshot failed integrity validation',
      { rightsSnapshotId: row.id },
    )
  }
  return snapshot
}

function rowData(snapshot: AssetRightsSnapshot, sequence: number) {
  return {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    artifactId: snapshot.artifactId,
    sequence,
    schemaVersion: snapshot.schemaVersion,
    snapshotHash: snapshot.snapshotHash,
    owner: snapshot.owner,
    license: snapshot.license,
    status: snapshot.status,
    allowedUsesJson: stableSerialize(snapshot.allowedUses),
    prohibitedUsesJson: stableSerialize(snapshot.prohibitedUses),
    allowedWorkspaceIdsJson: stableSerialize(snapshot.allowedWorkspaceIds),
    allowedMarketsJson: snapshot.allowedMarkets
      ? stableSerialize(snapshot.allowedMarkets)
      : undefined,
    allowedLocalesJson: snapshot.allowedLocales
      ? stableSerialize(snapshot.allowedLocales)
      : undefined,
    allowedSyntheticOperationsJson: snapshot.allowedSyntheticOperations
      ? stableSerialize(snapshot.allowedSyntheticOperations)
      : undefined,
    expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : undefined,
    consentStatus: snapshot.consent.status,
    consentAllowedUsesJson: stableSerialize(snapshot.consent.allowedUses),
    consentAllowedMarketsJson: snapshot.consent.allowedMarkets
      ? stableSerialize(snapshot.consent.allowedMarkets)
      : undefined,
    consentAllowedLocalesJson: snapshot.consent.allowedLocales
      ? stableSerialize(snapshot.consent.allowedLocales)
      : undefined,
    consentSyntheticOperationsJson: snapshot.consent.allowedSyntheticOperations
      ? stableSerialize(snapshot.consent.allowedSyntheticOperations)
      : undefined,
    consentExpiresAt: snapshot.consent.expiresAt
      ? new Date(snapshot.consent.expiresAt)
      : undefined,
    consentDocumentArtifactId: snapshot.consent.documentArtifactId,
    sourceNote: snapshot.sourceNote,
    createdByType: snapshot.createdBy.type,
    createdById: snapshot.createdBy.id,
    createdAt: new Date(snapshot.createdAt),
  }
}

export class PrismaAssetRightsRepository implements AssetRightsRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async findCurrent(
    workspaceId: string,
    artifactId: string,
  ): Promise<AssetRightsRecord | null> {
    const artifact = await this.client.v2MediaArtifact.findFirst({
      where: { id: artifactId, workspaceId },
      include: { currentRightsSnapshot: true },
    })
    if (!artifact) return null
    return {
      artifactId: artifact.id,
      revision: assetRightsRevision(artifact.id, artifact.rightsRevision),
      snapshot: artifact.currentRightsSnapshot
        ? hydrateRights(artifact.currentRightsSnapshot)
        : null,
    }
  }

  async findCurrentForArtifacts(
    workspaceId: string,
    artifactIds: readonly string[],
  ): Promise<ReadonlyMap<string, AssetRightsSnapshot | null>> {
    const uniqueIds = [...new Set(artifactIds)]
    const artifacts = await this.client.v2MediaArtifact.findMany({
      where: { workspaceId, id: { in: uniqueIds } },
      include: { currentRightsSnapshot: true },
    })
    return new Map(
      artifacts.map((artifact) => [
        artifact.id,
        artifact.currentRightsSnapshot
          ? hydrateRights(artifact.currentRightsSnapshot)
          : null,
      ]),
    )
  }

  async setCurrent(
    prototype: AssetRightsSnapshot,
    baseRevision: string,
    serializationAttempt = 1,
  ): Promise<SetAssetRightsResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const artifact = await transaction.v2MediaArtifact.findFirst({
          where: { id: prototype.artifactId, workspaceId: prototype.workspaceId },
        })
        if (!artifact) {
          throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
        }
        if (artifact.status === 'deleted') {
          throw new DomainError('INVALID_ARGUMENT', 'Deleted media artifact cannot receive rights')
        }
        const existing = await transaction.v2AssetRightsSnapshot.findUnique({
          where: {
            artifactId_snapshotHash: {
              artifactId: prototype.artifactId,
              snapshotHash: prototype.snapshotHash,
            },
          },
        })
        const currentRevision = assetRightsRevision(artifact.id, artifact.rightsRevision)
        if (existing && artifact.currentRightsSnapshotId === existing.id) {
          return {
            artifactId: artifact.id,
            revision: currentRevision,
            snapshot: hydrateRights(existing),
            replayed: true,
          }
        }
        if (currentRevision !== baseRevision) {
          throw new DomainError(
            'ASSET_RIGHTS_REVISION_MISMATCH',
            'Asset rights revision does not match',
          )
        }
        if (prototype.consent.documentArtifactId) {
          const evidence = await transaction.v2MediaArtifact.findFirst({
            where: {
              id: prototype.consent.documentArtifactId,
              workspaceId: prototype.workspaceId,
              status: { not: 'deleted' },
            },
            select: { id: true },
          })
          if (!evidence) {
            throw new DomainError(
              'INVALID_ARGUMENT',
              'Consent document artifact was not found in the workspace',
            )
          }
        }

        const revisionUpdate = await transaction.v2MediaArtifact.updateMany({
          where: {
            id: artifact.id,
            workspaceId: prototype.workspaceId,
            rightsRevision: artifact.rightsRevision,
          },
          data: {
            rightsRevision: { increment: 1 },
            ...(existing ? { currentRightsSnapshotId: existing.id } : {}),
          },
        })
        if (revisionUpdate.count !== 1) {
          throw new DomainError(
            'ASSET_RIGHTS_REVISION_MISMATCH',
            'Asset rights revision changed during update',
          )
        }
        const nextRevisionNumber = artifact.rightsRevision + 1

        if (existing) {
          return {
            artifactId: artifact.id,
            revision: assetRightsRevision(artifact.id, nextRevisionNumber),
            snapshot: hydrateRights(existing),
            replayed: false,
          }
        }

        const snapshot = createAssetRightsSnapshot({
          id: prototype.id,
          workspaceId: prototype.workspaceId,
          artifactId: prototype.artifactId,
          sequence: nextRevisionNumber,
          draft: draftFromSnapshot(prototype),
          createdBy: prototype.createdBy,
          createdAt: prototype.createdAt,
        })
        const created = await transaction.v2AssetRightsSnapshot.create({
          data: rowData(snapshot, snapshot.sequence),
        })
        await transaction.v2MediaArtifact.update({
          where: { id: artifact.id },
          data: { currentRightsSnapshotId: created.id },
        })
        return {
          artifactId: artifact.id,
          revision: assetRightsRevision(artifact.id, nextRevisionNumber),
          snapshot: hydrateRights(created),
          replayed: false,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.setCurrent(prototype, baseRevision, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Asset rights update conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const existing = await this.client.v2AssetRightsSnapshot.findUnique({
          where: {
            artifactId_snapshotHash: {
              artifactId: prototype.artifactId,
              snapshotHash: prototype.snapshotHash,
            },
          },
        })
        const artifact = await this.client.v2MediaArtifact.findFirst({
          where: { id: prototype.artifactId, workspaceId: prototype.workspaceId },
          select: { id: true, rightsRevision: true, currentRightsSnapshotId: true },
        })
        if (
          existing &&
          existing.workspaceId === prototype.workspaceId &&
          artifact?.currentRightsSnapshotId === existing.id
        ) {
          return {
            artifactId: prototype.artifactId,
            revision: assetRightsRevision(artifact.id, artifact.rightsRevision),
            snapshot: hydrateRights(existing),
            replayed: true,
          }
        }
      }
      throw error
    }
  }
}
