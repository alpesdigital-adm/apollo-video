import {
  Prisma,
  type PrismaClient,
  type V2SyntheticMasterConsumption,
} from '../../../../generated/prisma-v2/index.js'

import { isCurrentSyntheticCriticApproval } from '../../application/synthetic-critic.ts'
import type { MasterAlignmentReader } from '../../application/synthetic-speech-segments.ts'
import type {
  CanonicalSyntheticMasterReuseSource,
  SyntheticMasterReuseRepository,
} from '../../application/ports/synthetic-master-reuse-repository.ts'
import { calculateSyntheticMasterReuseProductionAlignmentHash } from '../../application/prepare-synthetic-master-reuse.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { DomainError } from '../../domain/errors.ts'
import { createSyntheticAvatarIdentity } from '../../domain/synthetic-cache-identity.ts'
import {
  assertSyntheticMasterConsumptionIntegrity,
  SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION,
  type SyntheticMasterConsumption,
} from '../../domain/synthetic-master-consumption.ts'
import { assertSyntheticPresenterPolicy } from '../../domain/synthetic-presenter-policy-engine.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { PrismaProviderJobRepository } from './provider-job-repository.ts'
import { PrismaSyntheticCriticReportRepository } from './synthetic-critic-report-repository.ts'
import { PrismaSyntheticMasterAssetRepository } from './synthetic-master-asset-repository.ts'
import { PrismaSyntheticProductionRepository } from './synthetic-production-repository.ts'

function hydrateConsumption(row: V2SyntheticMasterConsumption): Readonly<SyntheticMasterConsumption> {
  const consumption: SyntheticMasterConsumption = {
    schemaVersion: SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    consumerProjectId: row.consumerProjectId,
    consumerProjectVersionId: row.consumerProjectVersionId,
    productionRunId: row.productionRunId,
    sourceMasterId: row.sourceMasterId,
    sourceMasterHash: row.sourceMasterHash,
    sourceProjectId: row.sourceProjectId,
    sourceProjectVersionId: row.sourceProjectVersionId,
    sourceProviderJobId: row.sourceProviderJobId,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    cacheDecisionId: row.cacheDecisionId,
    cacheDecisionHash: row.cacheDecisionHash,
    productionPlanHash: row.productionPlanHash,
    observationOpenedAt: row.observationOpenedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    consumptionHash: row.consumptionHash,
  }
  if (row.schemaVersion !== consumption.schemaVersion) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic master consumption has an unknown schema version')
  }
  return assertSyntheticMasterConsumptionIntegrity(Object.freeze(consumption))
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isAuthorityFailure(error: unknown): boolean {
  return error instanceof DomainError && (
    error.code === 'ASSET_RIGHTS_BLOCKED' ||
    error.code === 'PRECONDITION_REQUIRED' ||
    error.code === 'VERSION_CONFLICT'
  )
}

export class PrismaSyntheticMasterReuseRepository implements SyntheticMasterReuseRepository {
  private readonly client: PrismaClient
  private readonly alignment: MasterAlignmentReader

  constructor(
    dependencies: {
      client?: PrismaClient
      alignment: MasterAlignmentReader
    },
  ) {
    this.client = dependencies.client ?? getV2PostgresClient()
    this.alignment = dependencies.alignment
  }

  async resolveCanonicalSource(
    input: Parameters<SyntheticMasterReuseRepository['resolveCanonicalSource']>[0],
  ): Promise<Readonly<CanonicalSyntheticMasterReuseSource> | null> {
    const resolved = await this.client.$transaction(async (transaction) => {
      const prisma = transaction as unknown as PrismaClient
      const masters = new PrismaSyntheticMasterAssetRepository(prisma)
      const jobs = new PrismaProviderJobRepository(prisma)
      const critics = new PrismaSyntheticCriticReportRepository(prisma)
      const profiles = new PrismaSyntheticProductionRepository(prisma)
      const persistedMaster = await masters.findByProviderJob({
        workspaceId: input.workspaceId,
        providerJobId: input.sourceProviderJobId,
      })
      if (!persistedMaster) return null
      const master = persistedMaster.master
      const providerOriginal = master.artifacts.find(({ role }) => role === 'provider-original')
      const finalAudio = master.artifacts.find(({ role }) => role === 'final-audio')
      const alignment = master.artifacts.find(({ role }) => role === 'alignment')
      if (
        !providerOriginal || !finalAudio || !alignment ||
        providerOriginal.artifactId !== input.sourceArtifactId ||
        providerOriginal.sha256 !== input.sourceArtifactSha256 ||
        alignment.sha256 !== master.alignmentHash
      ) return null

      const [persistedJob, report, profile, head, artifacts] = await Promise.all([
        jobs.readById({ workspaceId: input.workspaceId, jobId: input.sourceProviderJobId }),
        critics.readByHash({ workspaceId: input.workspaceId, reportHash: master.critic.reportHash }),
        profiles.readProfile({ workspaceId: input.workspaceId, snapshotId: master.profileSnapshotId }),
        profiles.readProfileHead({ workspaceId: input.workspaceId, profileId: master.profileId }),
        transaction.v2MediaArtifact.findMany({
          where: {
            workspaceId: input.workspaceId,
            id: { in: master.artifacts.map(({ artifactId }) => artifactId) },
            status: 'available',
          },
          include: { currentRightsSnapshot: true },
        }),
      ])
      if (!persistedJob || !report || !profile || !head) return null
      const sourceJob = persistedJob.job
      const criticBinding = object(sourceJob.input.criticBinding)
      const audioRange = object(sourceJob.input.audioRange)
      const outputSpeech = report.outputSpeechEvidence
      if (
        sourceJob.status !== 'approved' ||
        sourceJob.operation !== 'audio-avatar' ||
        sourceJob.workspaceId !== input.workspaceId ||
        sourceJob.projectId !== master.projectId ||
        sourceJob.originProjectVersionId !== master.projectVersionId ||
        sourceJob.criticResultHash !== master.critic.reportHash ||
        sourceJob.resultArtifact?.artifactId !== providerOriginal.artifactId ||
        sourceJob.resultArtifact.artifactSha256 !== providerOriginal.sha256 ||
        sourceJob.authorization.profileSnapshotId !== master.profileSnapshotId ||
        sourceJob.authorization.authorizationHash !== master.authorizationHash ||
        sourceJob.adapterId !== master.provenance.adapterId ||
        sourceJob.adapterVersion !== master.provenance.adapterVersion ||
        sourceJob.providerJobId !== master.provenance.providerJobRef ||
        sourceJob.input.audioArtifactId !== finalAudio.artifactId ||
        !audioRange ||
        audioRange.startMs !== 0 ||
        audioRange.endMs !== master.durationMs ||
        !criticBinding ||
        text(criticBinding.use) !== input.use ||
        text(criticBinding.market) !== input.market ||
        text(criticBinding.locale) !== input.locale ||
        criticBinding.expectedDurationMs !== master.durationMs ||
        criticBinding.alignmentArtifactId !== alignment.artifactId ||
        report.id !== master.critic.reportId ||
        report.projectId !== master.projectId ||
        report.profileSnapshotId !== master.profileSnapshotId ||
        report.capability !== 'audio-avatar' ||
        report.artifactId !== providerOriginal.artifactId ||
        report.artifactSha256 !== providerOriginal.sha256 ||
        report.audioArtifactId !== null ||
        report.alignmentArtifactId !== alignment.artifactId ||
        report.scriptHash !== master.scriptHash ||
        !outputSpeech || !outputSpeech.passed ||
        outputSpeech.sourceAudioArtifactId !== finalAudio.artifactId ||
        outputSpeech.sourceAudioRangeHash !== audioRange.rangeHash ||
        outputSpeech.sourceDurationMs !== master.durationMs ||
        outputSpeech.speechEvidence.outputTranscriptHash !== master.scriptHash ||
        outputSpeech.speechEvidence.observedIdentityRef !== profile.snapshot.avatar.identityRef ||
        !isCurrentSyntheticCriticApproval(report)
      ) return null

      const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
      if (
        artifacts.length !== new Set(master.artifacts.map(({ artifactId }) => artifactId)).size ||
        master.artifacts.some((artifact) => {
          const current = artifactsById.get(artifact.artifactId)
          return !current || current.sha256 !== artifact.sha256 ||
            Number(current.byteSize) !== artifact.byteSize ||
            current.mediaType !== artifact.mediaType || current.container !== artifact.container
        })
      ) return null

      let currentAuthorityValid = true
      try {
        assertSyntheticPresenterPolicy({
          snapshot: profile.snapshot,
          snapshotWorkspaceId: input.workspaceId,
          head: { currentVersion: head.head.currentVersion, current: head.current.snapshot },
          context: {
            operation: 'audio-avatar',
            use: input.use,
            market: input.market,
            locale: input.locale,
            workspaceId: input.workspaceId,
            now: input.at,
          },
        })
        currentAuthorityValid = master.artifacts.every((artifact) => {
          const current = artifactsById.get(artifact.artifactId)!
          const decision = evaluateAssetUse(
            current.currentRightsSnapshot ? hydrateAssetRights(current.currentRightsSnapshot) : null,
            {
              workspaceId: input.workspaceId,
              use: input.use,
              market: input.market,
              locale: input.locale,
              syntheticOperations: ['audio-avatar'],
            },
            input.at,
          )
          return decision.outcome === 'allow'
        })
      } catch (error) {
        if (!isAuthorityFailure(error)) throw error
        currentAuthorityValid = false
      }

      const cacheSubject = Object.freeze({
        operation: 'audio-avatar' as const,
        locale: master.locale,
        avatar: createSyntheticAvatarIdentity({
          adapterId: master.provenance.adapterId,
          adapterVersion: master.provenance.adapterVersion,
          avatarIdentityRef: profile.snapshot.avatar.identityRef,
          presenterVersion: master.profileVersion,
          modelRef: master.provenance.modelRef,
          outputFormat: providerOriginal.container,
          audioChecksum: finalAudio.sha256,
          renderConfig: Object.freeze({ sealedAdapterConfigHash: master.provenance.adapterConfigHash }),
          direction: null,
          background: profile.snapshot.visualContinuity?.background ?? null,
        }),
      })
      return Object.freeze({
        master,
        sourceJob,
        providerOriginal,
        finalAudio,
        alignment,
        cacheSubject,
        currentAuthorityValid,
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    if (!resolved) return null

    const words = await this.alignment.readWords({
      workspaceId: input.workspaceId,
      artifactId: resolved.alignment.artifactId,
    })
    const productionAlignmentHash = calculateSyntheticMasterReuseProductionAlignmentHash(
      words.map((word) => Object.freeze({ text: word.word, startMs: word.startMs, endMs: word.endMs })),
    )
    return Object.freeze({ ...resolved, productionAlignmentHash })
  }

  async readByRun(input: Parameters<SyntheticMasterReuseRepository['readByRun']>[0]) {
    const row = await this.client.v2SyntheticMasterConsumption.findUnique({
      where: {
        productionRunId_workspaceId_consumerProjectId: {
          productionRunId: input.productionRunId,
          workspaceId: input.workspaceId,
          consumerProjectId: input.consumerProjectId,
        },
      },
    })
    return row ? hydrateConsumption(row) : null
  }

  async listBySourceProjectVersion(
    input: Parameters<SyntheticMasterReuseRepository['listBySourceProjectVersion']>[0],
  ) {
    const rows = await this.client.v2SyntheticMasterConsumption.findMany({
      where: {
        workspaceId: input.workspaceId,
        sourceProjectId: input.sourceProjectId,
        sourceProjectVersionId: input.sourceProjectVersionId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateConsumption))
  }
}
