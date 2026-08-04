import {
  Prisma,
  type PrismaClient,
  type V2AssetRightsChange,
  type V2AssetRightsSnapshot,
} from '../../../../generated/prisma-v2/index.js'

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
import {
  createAssetRightsChangeIntent,
  type AssetRightsChangeIntent,
} from '../../domain/asset-rights-change.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'
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

export function hydrateAssetRights(row: V2AssetRightsSnapshot): AssetRightsSnapshot {
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

function changeData(
  change: AssetRightsChangeIntent,
  snapshotId: string,
  sequence: number,
  resultRevision: string,
) {
  const actor = change.actor.kind === 'external'
    ? {
        actorType: 'api-client' as const,
        actorId: change.actor.audit.clientId,
        external: change.actor.audit,
      }
    : {
        actorType: change.actor.actorType,
        actorId: change.actor.actorId,
        external: undefined,
      }
  const external = actor.external
  return {
    id: change.id,
    workspaceId: change.workspaceId,
    artifactId: change.artifactId,
    sequence,
    snapshotId,
    snapshotHash: change.snapshotHash,
    baseRevision: change.baseRevision,
    resultRevision,
    actorKind: change.actor.kind,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorClientId: external?.clientId,
    actorCredentialId: external?.credentialId,
    actorEnvironment: external?.environment,
    actorAuthenticationKind: external?.authenticationKind,
    actorDelegatedUserId: external?.delegatedUserId,
    actorDelegatedIdentityId: external?.delegatedIdentityId,
    actorWorkspaceRole: external?.workspaceRole,
    actorContextHash: external?.contextHash,
    requestFingerprint: change.requestFingerprint,
    changedAt: new Date(change.changedAt),
  }
}

function hydrateChangeIntent(row: V2AssetRightsChange): Readonly<AssetRightsChangeIntent> {
  const actor = row.actorKind === 'external'
    ? {
        kind: 'external' as const,
        audit: createApiAccessAuditContext({
          clientId: row.actorClientId ?? '',
          credentialId: row.actorCredentialId ?? '',
          workspaceId: row.workspaceId,
          environment: row.actorEnvironment as 'sandbox' | 'production',
          authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
          ...(row.actorDelegatedUserId ? { delegatedUserId: row.actorDelegatedUserId } : {}),
          ...(row.actorDelegatedIdentityId
            ? { delegatedIdentityId: row.actorDelegatedIdentityId }
            : {}),
          ...(row.actorWorkspaceRole
            ? { workspaceRole: row.actorWorkspaceRole as WorkspaceMemberRole }
            : {}),
        }),
      }
    : {
        kind: 'internal' as const,
        actorType: row.actorType as 'api-client' | 'user' | 'system',
        actorId: row.actorId,
      }
  const hydrated = createAssetRightsChangeIntent({
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    snapshotHash: row.snapshotHash,
    baseRevision: row.baseRevision,
    actor,
    changedAt: row.changedAt.toISOString(),
  })
  const externalFieldsAreEmpty = [
    row.actorClientId,
    row.actorCredentialId,
    row.actorEnvironment,
    row.actorAuthenticationKind,
    row.actorDelegatedUserId,
    row.actorDelegatedIdentityId,
    row.actorWorkspaceRole,
    row.actorContextHash,
  ].every((value) => value === null)
  if (
    row.id !== hydrated.id || row.requestFingerprint !== hydrated.requestFingerprint ||
    row.actorType !== (actor.kind === 'external' ? 'api-client' : actor.actorType) ||
    row.actorId !== (actor.kind === 'external' ? actor.audit.clientId : actor.actorId) ||
    (actor.kind === 'external' && row.actorContextHash !== actor.audit.contextHash) ||
    (actor.kind === 'internal' && !externalFieldsAreEmpty)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset rights change failed integrity validation')
  }
  return hydrated
}

function assertChangeMatches(
  row: V2AssetRightsChange | null,
  expected: AssetRightsChangeIntent,
  snapshotId: string,
  sequence: number,
  resultRevision: string,
): void {
  if (!row) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Asset rights revision is missing its audit change')
  }
  if (!changeMatches(row, expected, snapshotId, sequence, resultRevision)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Asset rights replay does not match its audit change')
  }
}

function changeMatches(
  row: V2AssetRightsChange,
  expected: AssetRightsChangeIntent,
  snapshotId: string,
  sequence: number,
  resultRevision: string,
): boolean {
  const hydrated = hydrateChangeIntent(row)
  return !(
    hydrated.requestFingerprint !== expected.requestFingerprint ||
    row.snapshotId !== snapshotId || row.sequence !== sequence ||
    row.resultRevision !== resultRevision
  )
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
      include: {
        currentRightsSnapshot: true,
        rightsChanges: { orderBy: { sequence: 'desc' }, take: 1 },
      },
    })
    if (!artifact) return null
    if (artifact.rightsRevision > 0 && artifact.currentRightsSnapshot) {
      const change = artifact.rightsChanges[0]
      if (!change) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Asset rights revision is missing its audit change')
      }
      assertChangeMatches(
        change,
        hydrateChangeIntent(change),
        artifact.currentRightsSnapshot.id,
        artifact.rightsRevision,
        assetRightsRevision(artifact.id, artifact.rightsRevision),
      )
    }
    return {
      artifactId: artifact.id,
      revision: assetRightsRevision(artifact.id, artifact.rightsRevision),
      snapshot: artifact.currentRightsSnapshot
        ? hydrateAssetRights(artifact.currentRightsSnapshot)
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
      include: {
        currentRightsSnapshot: true,
        rightsChanges: { orderBy: { sequence: 'desc' }, take: 1 },
      },
    })
    for (const artifact of artifacts) {
      if (artifact.rightsRevision > 0 && artifact.currentRightsSnapshot) {
        const change = artifact.rightsChanges[0]
        if (!change) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Asset rights revision is missing its audit change')
        }
        assertChangeMatches(
          change,
          hydrateChangeIntent(change),
          artifact.currentRightsSnapshot.id,
          artifact.rightsRevision,
          assetRightsRevision(artifact.id, artifact.rightsRevision),
        )
      }
    }
    return new Map(
      artifacts.map((artifact) => [
        artifact.id,
        artifact.currentRightsSnapshot
          ? hydrateAssetRights(artifact.currentRightsSnapshot)
          : null,
      ]),
    )
  }

  async setCurrent(
    prototype: AssetRightsSnapshot,
    baseRevision: string,
    change: AssetRightsChangeIntent,
    serializationAttempt = 1,
  ): Promise<SetAssetRightsResult> {
    if (
      change.workspaceId !== prototype.workspaceId ||
      change.artifactId !== prototype.artifactId ||
      change.snapshotHash !== prototype.snapshotHash ||
      change.baseRevision !== baseRevision
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Asset rights change does not match its snapshot')
    }
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
          const replayChange = await transaction.v2AssetRightsChange.findUnique({
            where: {
              artifactId_sequence: {
                artifactId: artifact.id,
                sequence: artifact.rightsRevision,
              },
            },
          })
          if (
            replayChange &&
            changeMatches(
              replayChange,
              change,
              existing.id,
              artifact.rightsRevision,
              currentRevision,
            )
          ) {
            return {
              artifactId: artifact.id,
              revision: currentRevision,
              snapshot: hydrateAssetRights(existing),
              replayed: true,
            }
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

        const selected = existing ?? await transaction.v2AssetRightsSnapshot.create({
          data: rowData(createAssetRightsSnapshot({
            id: prototype.id,
            workspaceId: prototype.workspaceId,
            artifactId: prototype.artifactId,
            sequence: nextRevisionNumber,
            draft: draftFromSnapshot(prototype),
            createdBy: prototype.createdBy,
            createdAt: prototype.createdAt,
          }), nextRevisionNumber),
        })
        if (!existing) {
          await transaction.v2MediaArtifact.update({
            where: { id: artifact.id },
            data: { currentRightsSnapshotId: selected.id },
          })
        }
        const resultRevision = assetRightsRevision(artifact.id, nextRevisionNumber)
        await transaction.v2AssetRightsChange.create({
          data: changeData(change, selected.id, nextRevisionNumber, resultRevision),
        })
        return {
          artifactId: artifact.id,
          revision: resultRevision,
          snapshot: hydrateAssetRights(selected),
          replayed: false,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.setCurrent(prototype, baseRevision, change, serializationAttempt + 1)
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
          const replayChange = await this.client.v2AssetRightsChange.findUnique({
            where: {
              artifactId_sequence: {
                artifactId: prototype.artifactId,
                sequence: artifact.rightsRevision,
              },
            },
          })
          assertChangeMatches(
            replayChange,
            change,
            existing.id,
            artifact.rightsRevision,
            assetRightsRevision(artifact.id, artifact.rightsRevision),
          )
          return {
            artifactId: prototype.artifactId,
            revision: assetRightsRevision(artifact.id, artifact.rightsRevision),
            snapshot: hydrateAssetRights(existing),
            replayed: true,
          }
        }
      }
      throw error
    }
  }
}
