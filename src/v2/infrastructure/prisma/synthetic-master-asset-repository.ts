import {
  Prisma,
  type PrismaClient,
  type V2SyntheticMasterArtifact,
  type V2SyntheticMasterAsset,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSyntheticMasterAsset,
  SyntheticMasterAssetRepository,
} from '../../application/ports/synthetic-master-asset-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticMasterIntegrity,
  SYNTHETIC_MASTER_ARTIFACT_ROLES,
  type SyntheticMasterAsset,
} from '../../domain/synthetic-master-asset.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type MasterRow = V2SyntheticMasterAsset & { artifacts: V2SyntheticMasterArtifact[] }

/**
 * Fail-closed rehydration: JSON, integral hash, every projected column and
 * every normalized artifact row must agree with the stored aggregate. A row
 * edited behind the application's back is a persistence conflict, never a
 * master that gets served.
 */
function hydrate(row: MasterRow): Readonly<PersistedSyntheticMasterAsset> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let master: SyntheticMasterAsset
  try {
    master = JSON.parse(row.masterJson) as SyntheticMasterAsset
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic master JSON is invalid')
  }
  assertSyntheticMasterIntegrity(master)
  const mismatch =
    stableSerialize(master) !== row.masterJson ||
    master.id !== row.id ||
    master.workspaceId !== row.workspaceId ||
    master.projectId !== row.projectId ||
    master.projectVersionId !== row.projectVersionId ||
    master.schemaVersion !== row.schemaVersion ||
    master.profileId !== row.profileId ||
    master.profileSnapshotId !== row.profileSnapshotId ||
    master.profileVersion !== row.profileVersion ||
    master.consentSnapshotHash !== row.consentSnapshotHash ||
    master.authorizationHash !== row.authorizationHash ||
    master.rightsSnapshotId !== row.rightsSnapshotId ||
    master.scriptText !== row.scriptText ||
    master.scriptHash !== row.scriptHash ||
    master.alignmentHash !== row.alignmentHash ||
    master.locale !== row.locale ||
    master.durationMs !== row.durationMs ||
    master.audioDurationMs !== row.audioDurationMs ||
    master.videoDurationMs !== row.videoDurationMs ||
    master.provenance.adapterId !== row.adapterId ||
    master.provenance.adapterVersion !== row.adapterVersion ||
    master.provenance.capability !== row.capability ||
    master.provenance.modelRef !== row.modelRef ||
    master.provenance.adapterConfigHash !== row.adapterConfigHash ||
    master.provenance.providerJobId !== row.providerJobId ||
    master.provenance.providerJobRef !== row.providerJobRef ||
    master.cost.currency !== row.costCurrency ||
    master.cost.minorUnits !== row.costMinorUnits ||
    master.cost.latencyMs !== row.latencyMs ||
    master.critic.reportId !== row.criticReportId ||
    master.critic.reportHash !== row.criticReportHash ||
    stableSerialize([...master.lineage]) !== row.lineageJson ||
    master.masterHash !== row.masterHash ||
    master.createdAt !== row.createdAt.toISOString()
  if (mismatch) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic master failed integrity validation')
  }
  const rows = new Map(row.artifacts.map((artifact) => [artifact.role, artifact]))
  if (rows.size !== master.artifacts.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic master artifact rows do not match the master')
  }
  for (const artifact of master.artifacts) {
    const persisted = rows.get(artifact.role)
    if (
      !persisted ||
      persisted.workspaceId !== master.workspaceId ||
      persisted.artifactId !== artifact.artifactId ||
      persisted.sha256 !== artifact.sha256 ||
      Number(persisted.byteSize) !== artifact.byteSize ||
      persisted.mediaType !== artifact.mediaType ||
      persisted.container !== artifact.container
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored synthetic master ${artifact.role} artifact was altered`)
    }
  }
  return Object.freeze({
    master: Object.freeze(master),
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

const INCLUDE_ARTIFACTS = { artifacts: true } as const

export class PrismaSyntheticMasterAssetRepository implements SyntheticMasterAssetRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findReplay(input: Parameters<SyntheticMasterAssetRepository['findReplay']>[0]) {
    const row = await this.client.v2SyntheticMasterAsset.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_actorContextHash_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          actorContextHash: input.actorContextHash,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: INCLUDE_ARTIFACTS,
    })
    return row ? hydrate(row) : null
  }

  async create(input: Parameters<SyntheticMasterAssetRepository['create']>[0]) {
    const master = input.master
    try {
      const row = await this.client.$transaction(async (transaction) => {
        const profile = await transaction.v2SyntheticPresenterProfile.findFirst({
          where: {
            id: master.profileSnapshotId,
            workspaceId: master.workspaceId,
            profileHash: input.profileSnapshotHash,
          },
          select: { id: true },
        })
        assertDomain(
          Boolean(profile),
          'VERSION_CONFLICT',
          'Synthetic presenter snapshot changed before the master was sealed',
        )
        const job = await transaction.v2ProviderJob.findFirst({
          where: {
            id: master.provenance.providerJobId,
            workspaceId: master.workspaceId,
            status: 'approved',
            criticResultHash: input.criticResultHash,
          },
          select: { id: true },
        })
        assertDomain(
          Boolean(job),
          'VERSION_CONFLICT',
          'Provider job is no longer approved with the critic result the master was validated against',
        )
        return transaction.v2SyntheticMasterAsset.create({
          data: {
            id: master.id,
            workspaceId: master.workspaceId,
            projectId: master.projectId,
            projectVersionId: master.projectVersionId,
            schemaVersion: master.schemaVersion,
            profileId: master.profileId,
            profileSnapshotId: master.profileSnapshotId,
            profileVersion: master.profileVersion,
            consentSnapshotHash: master.consentSnapshotHash,
            authorizationHash: master.authorizationHash,
            rightsSnapshotId: master.rightsSnapshotId,
            scriptText: master.scriptText,
            scriptHash: master.scriptHash,
            alignmentHash: master.alignmentHash,
            locale: master.locale,
            durationMs: master.durationMs,
            audioDurationMs: master.audioDurationMs,
            videoDurationMs: master.videoDurationMs,
            adapterId: master.provenance.adapterId,
            adapterVersion: master.provenance.adapterVersion,
            capability: master.provenance.capability,
            modelRef: master.provenance.modelRef,
            adapterConfigHash: master.provenance.adapterConfigHash,
            providerJobId: master.provenance.providerJobId,
            providerJobRef: master.provenance.providerJobRef,
            costCurrency: master.cost.currency,
            costMinorUnits: master.cost.minorUnits,
            latencyMs: master.cost.latencyMs,
            criticReportId: master.critic.reportId,
            criticReportHash: master.critic.reportHash,
            lineageJson: stableSerialize([...master.lineage]),
            masterJson: stableSerialize(master),
            masterHash: master.masterHash,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
            createdByClientId: input.authenticationAudit.clientId,
            ...externalActorAuditData(
              input.authenticationAudit,
              master.workspaceId,
              input.authenticationAudit.clientId,
            ),
            createdAt: new Date(master.createdAt),
          },
        }).then(async (created) => {
          // The artifact rows share the master's composite workspace key, so
          // they are written explicitly inside the same transaction: either
          // the master and all four roles exist, or none of them do.
          await transaction.v2SyntheticMasterArtifact.createMany({
            data: master.artifacts.map((artifact) => ({
              masterId: created.id,
              workspaceId: master.workspaceId,
              role: artifact.role,
              artifactId: artifact.artifactId,
              sha256: artifact.sha256,
              byteSize: BigInt(artifact.byteSize),
              mediaType: artifact.mediaType,
              container: artifact.container,
              createdAt: new Date(master.createdAt),
            })),
          })
          return transaction.v2SyntheticMasterAsset.findUniqueOrThrow({
            where: { id: created.id },
            include: INCLUDE_ARTIFACTS,
          })
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ value: hydrate(row), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findReplay({
          workspaceId: master.workspaceId,
          projectId: master.projectId,
          actorClientId: input.authenticationAudit.clientId,
          actorContextHash: input.authenticationAudit.contextHash,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay && replay.requestFingerprint === input.requestFingerprint) {
          return Object.freeze({ value: replay, replayed: true })
        }
        // A concurrent promotion of the very same performance already sealed
        // the master: the content address is the identity, so the winner is
        // returned instead of publishing a duplicate.
        const sealed = await this.findByMasterHash({
          workspaceId: master.workspaceId,
          masterHash: master.masterHash,
        })
        if (sealed) return Object.freeze({ value: sealed, replayed: true })
        throw new DomainError('VERSION_CONFLICT', 'Synthetic master identity or idempotency key already exists')
      }
      throw error
    }
  }

  async read(input: Parameters<SyntheticMasterAssetRepository['read']>[0]) {
    const row = await this.client.v2SyntheticMasterAsset.findFirst({
      where: { id: input.masterId, workspaceId: input.workspaceId },
      include: INCLUDE_ARTIFACTS,
    })
    return row ? hydrate(row) : null
  }

  async findByProviderJob(input: Parameters<SyntheticMasterAssetRepository['findByProviderJob']>[0]) {
    const row = await this.client.v2SyntheticMasterAsset.findFirst({
      where: { workspaceId: input.workspaceId, providerJobId: input.providerJobId },
      include: INCLUDE_ARTIFACTS,
    })
    return row ? hydrate(row) : null
  }

  async findByMasterHash(input: Parameters<SyntheticMasterAssetRepository['findByMasterHash']>[0]) {
    const row = await this.client.v2SyntheticMasterAsset.findFirst({
      where: { workspaceId: input.workspaceId, masterHash: input.masterHash },
      include: INCLUDE_ARTIFACTS,
    })
    return row ? hydrate(row) : null
  }

  async list(input: Parameters<SyntheticMasterAssetRepository['list']>[0]) {
    const rows = await this.client.v2SyntheticMasterAsset.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.scriptHash ? { scriptHash: input.scriptHash } : {}),
      },
      include: INCLUDE_ARTIFACTS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }
}

export const SYNTHETIC_MASTER_ARTIFACT_ROLE_ORDER = SYNTHETIC_MASTER_ARTIFACT_ROLES
