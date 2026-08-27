import {
  Prisma,
  type PrismaClient,
  type V2SyntheticPresenterProfile,
  type V2SyntheticProductionAsset,
  type V2SyntheticProductionRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSyntheticPresenterProfile,
  PersistedSyntheticProductionRun,
  SyntheticProductionRepository,
} from '../../application/ports/synthetic-production-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticPresenterEditPlan,
  createSyntheticPresenterProfileSnapshot,
  type SyntheticPresenterEditPlan,
  type SyntheticPresenterProfileSnapshot,
} from '../../domain/synthetic-production.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'

type RunWithAssets = V2SyntheticProductionRun & {
  assets: V2SyntheticProductionAsset[]
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function canonicalValue<T>(value: string, field: string): Readonly<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid JSON`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    stableSerialize(parsed) !== value
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is not canonical`)
  }
  return deepFreeze(parsed as T)
}

function hydrateProfile(
  row: V2SyntheticPresenterProfile,
): Readonly<PersistedSyntheticPresenterProfile> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const stored = canonicalValue<SyntheticPresenterProfileSnapshot>(
    row.profileJson,
    `synthetic presenter profile ${row.id}`,
  )
  if (row.id !== `${stored.id}:v${stored.version}`) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored synthetic presenter profile ${row.id} lost its versioned physical identity`,
    )
  }
  const recreated = createSyntheticPresenterProfileSnapshot({
    id: stored.id,
    version: stored.version,
    actorIdentityId: stored.actorIdentityId,
    avatar: stored.avatar,
    voice: stored.voice,
    defaultLocale: stored.defaultLocale,
    status: stored.status,
    disclosure: stored.disclosure,
    consent: {
      id: stored.consent.id,
      evidenceArtifactId: stored.consent.evidenceArtifactId,
      evidenceSha256: stored.consent.evidenceSha256,
      granted: stored.consent.granted,
      allowedUses: stored.consent.allowedUses,
      allowedMarkets: stored.consent.allowedMarkets,
      allowedLocales: stored.consent.allowedLocales,
      allowedOperations: stored.consent.allowedOperations,
      expiresAt: stored.consent.expiresAt,
      ...(stored.consent.revokedAt ? { revokedAt: stored.consent.revokedAt } : {}),
    },
  })
  if (
    stableSerialize(recreated) !== row.profileJson ||
    recreated.id !== row.profileId ||
    recreated.version !== row.version ||
    recreated.snapshotHash !== row.profileHash ||
    recreated.consent.snapshotHash !== row.consentSnapshotHash ||
    recreated.status !== row.status ||
    recreated.actorIdentityId !== row.actorIdentityId ||
    recreated.defaultLocale !== row.defaultLocale ||
    recreated.disclosure !== row.disclosure
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored synthetic presenter profile ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    snapshot: recreated,
    profileSnapshotId: row.id,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
}

function expectedAssets(plan: Readonly<SyntheticPresenterEditPlan>) {
  return [
    {
      id: `${plan.id}:asset:0`,
      artifactId: plan.audio.artifactId,
      role: 'audio-master',
      startMs: null,
      endMs: null,
      providerJobId: null,
      criticHash: null,
      artifactSha256: plan.audio.sha256,
    },
    ...plan.blocks.map((entry, index) => ({
      id: `${plan.id}:asset:${index + 1}`,
      artifactId: entry.artifact.artifactId,
      role: 'synthetic-block',
      startMs: entry.rangeMs[0],
      endMs: entry.rangeMs[1],
      providerJobId: entry.providerJobId,
      criticHash: entry.critic.resultHash,
      artifactSha256: entry.artifact.sha256,
    })),
    ...plan.bRoll.map((entry, index) => ({
      id: `${plan.id}:asset:${plan.blocks.length + index + 1}`,
      artifactId: entry.artifact.artifactId,
      role: 'b-roll',
      startMs: entry.rangeMs[0],
      endMs: entry.rangeMs[1],
      providerJobId: null,
      criticHash: null,
      artifactSha256: entry.artifact.sha256,
    })),
    ...plan.overlays.map((entry, index) => ({
      id: `${plan.id}:asset:${plan.blocks.length + plan.bRoll.length + index + 1}`,
      artifactId: entry.artifact.artifactId,
      role: 'overlay',
      startMs: entry.rangeMs[0],
      endMs: entry.rangeMs[1],
      providerJobId: null,
      criticHash: null,
      artifactSha256: entry.artifact.sha256,
    })),
  ]
}

function hydrateRun(
  row: RunWithAssets,
): Readonly<PersistedSyntheticProductionRun> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const plan = canonicalValue<SyntheticPresenterEditPlan>(
    row.planJson,
    `synthetic production run ${row.id}`,
  )
  assertSyntheticPresenterEditPlan(plan)
  const expected = expectedAssets(plan)
  const stored = row.assets.toSorted((left, right) => left.ordinal - right.ordinal)
  if (
    plan.id !== row.id ||
    plan.workspaceId !== row.workspaceId ||
    plan.projectId !== row.projectId ||
    plan.projectVersionId !== row.projectVersionId ||
    `${plan.profile.id}:v${plan.profile.version}` !== row.profileSnapshotId ||
    plan.schemaVersion !== row.schemaVersion ||
    plan.policyVersion !== row.policyVersion ||
    plan.use !== row.use ||
    plan.market !== row.market ||
    plan.locale !== row.locale ||
    plan.durationMs !== row.durationMs ||
    plan.authorization.id !== row.authorizationId ||
    plan.authorization.authorizationHash !== row.authorizationHash ||
    plan.planHash !== row.planHash ||
    stableSerialize(plan) !== row.planJson ||
    expected.length !== stored.length ||
    expected.some((entry, index) => {
      const asset = stored[index]!
      return entry.id !== asset.id ||
        entry.artifactId !== asset.artifactId ||
        entry.role !== asset.role ||
        entry.startMs !== asset.startMs ||
        entry.endMs !== asset.endMs ||
        entry.providerJobId !== asset.providerJobId ||
        entry.criticHash !== asset.criticHash ||
        entry.artifactSha256 !== asset.artifactSha256
    })
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored synthetic production run ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    plan,
    editPlanSnapshotId: row.editPlanSnapshotId,
    status: row.status as PersistedSyntheticProductionRun['status'],
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

export class PrismaSyntheticProductionRepository
implements SyntheticProductionRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma
  }

  async findProfileReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }) {
    const row = await this.prisma.v2SyntheticPresenterProfile.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row ? hydrateProfile(row) : null
  }

  async createProfile(input: Parameters<SyntheticProductionRepository['createProfile']>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const [actor, evidence, latest] = await Promise.all([
          transaction.v2ApiClient.findFirst({
            where: {
              id: input.authenticationAudit.clientId,
              workspaceId: input.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: input.snapshot.consent.evidenceArtifactId,
              workspaceId: input.workspaceId,
              sha256: input.snapshot.consent.evidenceSha256,
              mediaType: 'data',
              status: 'available',
            },
            select: { id: true },
          }),
          transaction.v2SyntheticPresenterProfile.findFirst({
            where: {
              workspaceId: input.workspaceId,
              profileId: input.snapshot.id,
            },
            orderBy: { version: 'desc' },
            select: { version: true },
          }),
        ])
        if (!actor || !evidence || input.snapshot.version !== (latest?.version ?? 0) + 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Synthetic profile actor, consent evidence or next version changed before commit',
          )
        }
        const row = await transaction.v2SyntheticPresenterProfile.create({
          data: {
            id: `${input.snapshot.id}:v${input.snapshot.version}`,
            workspaceId: input.workspaceId,
            profileId: input.snapshot.id,
            version: input.snapshot.version,
            schemaVersion: 'synthetic-presenter-profile/v1',
            status: input.snapshot.status,
            actorIdentityId: input.snapshot.actorIdentityId,
            defaultLocale: input.snapshot.defaultLocale,
            disclosure: input.snapshot.disclosure,
            consentSnapshotHash: input.snapshot.consent.snapshotHash,
            profileJson: stableSerialize(input.snapshot),
            profileHash: input.snapshot.snapshotHash,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
            createdByClientId: input.authenticationAudit.clientId,
            ...externalActorAuditData(
              input.authenticationAudit,
              input.workspaceId,
              input.authenticationAudit.clientId,
            ),
            createdAt: new Date(input.createdAt),
          },
        })
        return Object.freeze({ profile: hydrateProfile(row), replayed: false })
      })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findProfileReplay({
        workspaceId: input.workspaceId,
        actorClientId: input.authenticationAudit.clientId,
        actorContextHash: input.authenticationAudit.contextHash,
        idempotencyKey: input.idempotencyKey,
      })
      if (!replay || replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Synthetic profile version or idempotency key already exists',
        )
      }
      return Object.freeze({ profile: replay, replayed: true })
    }
  }

  async readProfile(input: { workspaceId: string; snapshotId: string }) {
    const row = await this.prisma.v2SyntheticPresenterProfile.findFirst({
      where: {
        workspaceId: input.workspaceId,
        OR: [{ id: input.snapshotId }, { profileId: input.snapshotId }],
      },
      orderBy: { version: 'desc' },
    })
    return row ? hydrateProfile(row) : null
  }

  async findRunReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }) {
    const row = await this.prisma.v2SyntheticProductionRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
      include: { assets: { orderBy: { ordinal: 'asc' } } },
    })
    return row ? hydrateRun(row) : null
  }

  async createRun(input: Parameters<SyntheticProductionRepository['createRun']>[0]) {
    const { plan } = input
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const [project, profile, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: plan.projectId,
              workspaceId: plan.workspaceId,
              currentVersionId: plan.projectVersionId,
            },
            select: { id: true },
          }),
          transaction.v2SyntheticPresenterProfile.findFirst({
            where: {
              workspaceId: plan.workspaceId,
              profileId: plan.profile.id,
              version: plan.profile.version,
              profileHash: plan.profile.snapshotHash,
              consentSnapshotHash: plan.profile.consent.snapshotHash,
              status: 'active',
            },
            select: { id: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: input.authenticationAudit.clientId,
              workspaceId: plan.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!project || !profile || !actor) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Synthetic project version, presenter profile or actor changed before commit',
          )
        }
        const assets = expectedAssets(plan)
        const persistedAssets = await transaction.v2MediaArtifact.findMany({
          where: {
            workspaceId: plan.workspaceId,
            id: { in: assets.map((entry) => entry.artifactId) },
            status: 'available',
          },
          include: { currentRightsSnapshot: true },
        })
        const byId = new Map(persistedAssets.map((entry) => [entry.id, entry]))
        for (const asset of assets) {
          const row = byId.get(asset.artifactId)
          const decision = plan.authorization.decisions.find((entry) =>
            entry.artifactId === asset.artifactId)
          if (
            !row ||
            !decision ||
            row.sha256 !== asset.artifactSha256 ||
            row.currentRightsSnapshotId !== decision.rightsSnapshotId ||
            row.currentRightsSnapshot?.snapshotHash !== decision.rightsSnapshotHash ||
            Date.parse(decision.validUntil) <= Date.parse(plan.createdAt)
          ) {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              `Synthetic asset ${asset.artifactId} changed before commit`,
            )
          }
        }
        await transaction.v2ProjectSnapshot.create({
          data: {
            id: input.editPlanSnapshot.id,
            workspaceId: input.editPlanSnapshot.workspaceId,
            projectId: input.editPlanSnapshot.projectId,
            kind: input.editPlanSnapshot.kind,
            schemaVersion: input.editPlanSnapshot.contentSchemaVersion,
            contentJson: input.editPlanSnapshot.contentJson,
            contentHash: input.editPlanSnapshot.contentHash,
            createdAt: new Date(input.editPlanSnapshot.createdAt),
          },
        })
        await transaction.v2SyntheticProductionRun.create({
          data: {
            id: plan.id,
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            projectVersionId: plan.projectVersionId,
            profileSnapshotId: profile.id,
            editPlanSnapshotId: input.editPlanSnapshot.id,
            schemaVersion: plan.schemaVersion,
            policyVersion: plan.policyVersion,
            status: 'compiled',
            use: plan.use,
            market: plan.market,
            locale: plan.locale,
            durationMs: plan.durationMs,
            authorizationId: plan.authorization.id,
            authorizationHash: plan.authorization.authorizationHash,
            planJson: stableSerialize(plan),
            planHash: plan.planHash,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
            createdByClientId: input.authenticationAudit.clientId,
            ...externalActorAuditData(
              input.authenticationAudit,
              plan.workspaceId,
              input.authenticationAudit.clientId,
            ),
            createdAt: new Date(plan.createdAt),
          },
        })
        await transaction.v2SyntheticProductionAsset.createMany({
          data: assets.map((asset, ordinal) => ({
            ...asset,
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            runId: plan.id,
            ordinal,
          })),
        })
        const row = await transaction.v2SyntheticProductionRun.findUniqueOrThrow({
          where: { id: plan.id },
          include: { assets: { orderBy: { ordinal: 'asc' } } },
        })
        return Object.freeze({ run: hydrateRun(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findRunReplay({
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        actorClientId: input.authenticationAudit.clientId,
        actorContextHash: input.authenticationAudit.contextHash,
        idempotencyKey: input.idempotencyKey,
      })
      if (!replay || replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Synthetic run or idempotency key already exists',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
  }

  async readRun(input: { workspaceId: string; projectId: string; runId: string }) {
    const row = await this.prisma.v2SyntheticProductionRun.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: { assets: { orderBy: { ordinal: 'asc' } } },
    })
    return row ? hydrateRun(row) : null
  }
}
