import {
  Prisma,
  type PrismaClient,
  type V2SyntheticAudioMaster,
  type V2SyntheticPresenterProfile,
  type V2SyntheticProductionAsset,
  type V2SyntheticProductionRun,
} from '../../../../generated/prisma-v2/index.js'
import { createHash } from 'node:crypto'

import type {
  PersistedSyntheticPresenterProfile,
  PersistedSyntheticProductionRun,
  SyntheticProductionRepository,
} from '../../application/ports/synthetic-production-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import {
  assertSyntheticCacheDecisionIntegrity,
  assertSyntheticCacheDecisionPrivacy,
  type SyntheticCacheDecision,
} from '../../domain/synthetic-cache-decision.ts'
import { assertSyntheticMasterConsumptionIntegrity } from '../../domain/synthetic-master-consumption.ts'
import { assertSyntheticPresenterPolicy } from '../../domain/synthetic-presenter-policy-engine.ts'
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
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { PrismaProviderJobRepository } from './provider-job-repository.ts'
import { PrismaSyntheticAudioMasterRepository } from './synthetic-audio-master-repository.ts'
import { PrismaSyntheticCriticReportRepository } from './synthetic-critic-report-repository.ts'
import { PrismaSyntheticMasterAssetRepository } from './synthetic-master-asset-repository.ts'
import { isCurrentSyntheticCriticApproval } from '../../application/synthetic-critic.ts'

const sha256Text = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

type RunWithAssets = V2SyntheticProductionRun & {
  assets: V2SyntheticProductionAsset[]
  audioMaster: V2SyntheticAudioMaster | null
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

export function hydrateSyntheticPresenterProfile(
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
    ...(stored.pronunciationDictionaryRef ? { pronunciationDictionaryRef: stored.pronunciationDictionaryRef } : {}),
    ...(stored.visualContinuity ? { visualContinuity: stored.visualContinuity } : {}),
    ...(stored.restrictions ? { restrictions: stored.restrictions } : {}),
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

function cacheDecisionData(decision: Readonly<SyntheticCacheDecision>) {
  return {
    id: decision.id,
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    schemaVersion: decision.schemaVersion,
    operation: decision.operation,
    cacheKey: decision.cacheKey,
    cacheKeyVersion: decision.cacheKeyVersion,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    candidateGenerationId: decision.candidateGenerationId,
    candidateMasterId: decision.candidateMasterId,
    policyVersion: decision.policyVersion,
    criticReportHash: decision.criticReportHash,
    estimatedSavingMinorUnits: decision.estimatedSavingMinorUnits,
    avoidedCostMinorUnits: decision.avoidedCostMinorUnits,
    currency: decision.currency,
    subjectHash: decision.subjectHash,
    decisionHash: decision.decisionHash,
    decidedAt: new Date(decision.decidedAt),
  }
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
    ((row.audioMasterId === null || row.audioMasterHash === null || row.audioOriginProjectId === null)
      ? !(row.audioMasterId === null && row.audioMasterHash === null && row.audioOriginProjectId === null && row.audioMaster === null)
      : (!row.audioMaster || row.audioMaster.id !== row.audioMasterId ||
        row.audioMaster.masterHash !== row.audioMasterHash || row.audioMaster.projectId !== row.audioOriginProjectId)) ||
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
    audioMaster: row.audioMasterId && row.audioMasterHash && row.audioOriginProjectId
      ? Object.freeze({ id: row.audioMasterId, masterHash: row.audioMasterHash, originProjectId: row.audioOriginProjectId })
      : null,
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

  private async validateCanonicalAudioAndReuse(
    transaction: Prisma.TransactionClient,
    input: Parameters<SyntheticProductionRepository['createRun']>[0],
    profile: Readonly<PersistedSyntheticPresenterProfile>,
  ) {
    const { plan } = input
    const prisma = transaction as unknown as PrismaClient
    const jobs = new PrismaProviderJobRepository(prisma)
    const critics = new PrismaSyntheticCriticReportRepository(prisma)
    const audioMasters = new PrismaSyntheticAudioMasterRepository(prisma)
    const sourceJobs = await Promise.all(plan.blocks.map(({ providerJobId }) =>
      jobs.readById({ workspaceId: plan.workspaceId, jobId: providerJobId })))
    assertDomain(
      sourceJobs.length > 0 && sourceJobs.every((persisted) =>
        persisted?.job.status === 'approved' &&
        persisted.job.operation === 'audio-avatar' &&
        persisted.job.input.audioMasterId === input.audioMaster.id),
      'VERSION_CONFLICT',
      'Synthetic production provider jobs no longer bind one approved canonical audio master',
    )
    const reports = await Promise.all(plan.blocks.map(({ critic }) =>
      critics.readByHash({ workspaceId: plan.workspaceId, reportHash: critic.resultHash })))
    for (const [index, block] of plan.blocks.entries()) {
      const job = sourceJobs[index]!.job
      const report = reports[index]
      const range = typeof job.input.audioRange === 'object' && job.input.audioRange !== null
        ? job.input.audioRange as Record<string, unknown>
        : null
      assertDomain(
        Boolean(report) && report!.id === block.critic.id && isCurrentSyntheticCriticApproval(report!) &&
          report!.providerJobId === job.id && report!.projectId === job.projectId &&
          report!.profileSnapshotId === profile.profileSnapshotId &&
          report!.artifactId === block.artifact.artifactId && report!.artifactSha256 === block.artifact.sha256 &&
          report!.scriptHash === sha256Text(block.text) && report!.capability === 'audio-avatar' &&
          report!.outputSpeechEvidence?.passed === true &&
          report!.outputSpeechEvidence.sourceAudioArtifactId === plan.audio.artifactId &&
          job.criticResultHash === report!.reportHash &&
          job.authorization.profileSnapshotId === profile.profileSnapshotId &&
          job.resultArtifact?.artifactId === block.artifact.artifactId &&
          job.resultArtifact.artifactSha256 === block.artifact.sha256 &&
          job.input.audioArtifactId === plan.audio.artifactId &&
          range?.startMs === block.rangeMs[0] && range.endMs === block.rangeMs[1],
        'VERSION_CONFLICT',
        `Synthetic block ${block.id} lost its exact worker approval before commit`,
      )
    }
    const sourceJob = sourceJobs[0]!.job
    const persistedAudioMaster = await audioMasters.read({
      workspaceId: plan.workspaceId,
      projectId: input.audioMaster.originProjectId,
      audioMasterId: input.audioMaster.id,
    })
    assertDomain(Boolean(persistedAudioMaster), 'VERSION_CONFLICT', 'Canonical audio master changed before commit')
    const audioMaster = persistedAudioMaster!.master
    const canonicalAlignment = audioMaster.words.map(({ word, startMs, endMs }) => ({ text: word, startMs, endMs }))
    let canonicalScriptHash: string
    if (audioMaster.source.kind === 'tts') {
      canonicalScriptHash = sha256Text(audioMaster.source.text)
    } else if (audioMaster.source.kind === 'uploaded') {
      canonicalScriptHash = sha256Text(audioMaster.words.map(({ word }) => word).join(' '))
    } else {
      const sourcePlan = await transaction.v2SyntheticScriptPlanVersion.findFirst({
        where: {
          id: audioMaster.source.planVersionId,
          workspaceId: plan.workspaceId,
          planId: audioMaster.source.planId,
        },
        select: { scriptHash: true },
      })
      assertDomain(Boolean(sourcePlan), 'PERSISTENCE_CONFLICT', 'Canonical concatenated audio lost its script plan')
      canonicalScriptHash = sourcePlan!.scriptHash
    }
    assertDomain(
      audioMaster.masterHash === input.audioMaster.masterHash &&
        audioMaster.projectId === input.audioMaster.originProjectId &&
        audioMaster.profileSnapshotId === profile.profileSnapshotId &&
        audioMaster.audio.artifactId === plan.audio.artifactId &&
        audioMaster.audio.artifactSha256 === plan.audio.sha256 &&
        audioMaster.audio.durationMs === plan.audio.durationMs &&
        audioMaster.audio.locale === plan.audio.locale &&
        audioMaster.words[0]?.startMs === 0 &&
        audioMaster.words.at(-1)?.endMs === audioMaster.audio.durationMs &&
        canonicalScriptHash === plan.audio.scriptHash &&
        stableSerialize(canonicalAlignment) === stableSerialize(plan.audio.alignment),
      'VERSION_CONFLICT',
      'Canonical audio master bytes, profile, script, alignment or timing changed before commit',
    )
    const evidenceRows = await transaction.v2MediaArtifact.findMany({
      where: {
        workspaceId: plan.workspaceId,
        id: { in: [audioMaster.audio.artifactId, audioMaster.alignmentEvidence.artifactId] },
        status: 'available',
      },
      include: { currentRightsSnapshot: true },
    })
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]))
    assertDomain(
      [
        { id: audioMaster.audio.artifactId, sha256: audioMaster.audio.artifactSha256 },
        { id: audioMaster.alignmentEvidence.artifactId, sha256: audioMaster.alignmentEvidence.artifactSha256 },
      ].every((reference) => {
        const row = evidenceById.get(reference.id)
        if (!row || row.sha256 !== reference.sha256) return false
        const rights = row.currentRightsSnapshot ? hydrateAssetRights(row.currentRightsSnapshot) : null
        return evaluateAssetUse(rights, {
          workspaceId: plan.workspaceId,
          use: plan.use,
          market: plan.market,
          locale: plan.locale,
          syntheticOperations: ['audio-avatar'],
        }, new Date()).outcome === 'allow'
      }),
      'ASSET_RIGHTS_BLOCKED',
      'Canonical audio or alignment evidence lost current authority before commit',
    )

    const canonicalReuse = input.canonicalReuse
    if (!canonicalReuse) return null
    const decision = assertSyntheticCacheDecisionIntegrity(canonicalReuse.decision)
    assertSyntheticCacheDecisionPrivacy(decision)
    const consumption = assertSyntheticMasterConsumptionIntegrity(canonicalReuse.consumption)
    assertDomain(
      decision.workspaceId === plan.workspaceId &&
        decision.projectId === plan.projectId &&
        decision.operation === 'audio-avatar' &&
        decision.outcome === 'hit' &&
        decision.reasonCode === 'CACHE_HIT_ELIGIBLE' &&
        decision.candidateGenerationId === null &&
        decision.candidateMasterId === consumption.sourceMasterId &&
        decision.decisionHash === consumption.cacheDecisionHash &&
        decision.id === consumption.cacheDecisionId &&
        decision.criticReportHash !== null &&
        consumption.workspaceId === plan.workspaceId &&
        consumption.consumerProjectId === plan.projectId &&
        consumption.consumerProjectVersionId === plan.projectVersionId &&
        consumption.productionRunId === plan.id &&
        consumption.productionPlanHash === plan.planHash &&
        consumption.createdAt === decision.decidedAt,
      'PERSISTENCE_CONFLICT',
      'Canonical master reuse proposal does not match the production run and cache decision',
    )
    const project = await transaction.v2Project.findFirst({
      where: { id: plan.projectId, workspaceId: plan.workspaceId },
      select: { createdAt: true },
    })
    assertDomain(
      Boolean(project) && consumption.observationOpenedAt === project!.createdAt.toISOString(),
      'VERSION_CONFLICT',
      'Canonical reuse observation must cover the complete lifetime of the consuming project',
    )

    const masters = new PrismaSyntheticMasterAssetRepository(prisma)
    const persistedMaster = await masters.findByProviderJob({
      workspaceId: plan.workspaceId,
      providerJobId: consumption.sourceProviderJobId,
    })
    assertDomain(Boolean(persistedMaster), 'VERSION_CONFLICT', 'Canonical reused master changed before commit')
    const master = persistedMaster!.master
    const providerOriginal = master.artifacts.find(({ role }) => role === 'provider-original')
    const finalAudio = master.artifacts.find(({ role }) => role === 'final-audio')
    const alignment = master.artifacts.find(({ role }) => role === 'alignment')
    const sourceBlock = plan.blocks[0]
    assertDomain(
      plan.blocks.length === 1 && Boolean(sourceBlock) &&
        sourceBlock!.rangeMs[0] === 0 && sourceBlock!.rangeMs[1] === plan.durationMs &&
        master.id === consumption.sourceMasterId &&
        master.masterHash === consumption.sourceMasterHash &&
        master.projectId === consumption.sourceProjectId &&
        master.projectVersionId === consumption.sourceProjectVersionId &&
        master.projectId !== plan.projectId &&
        master.profileSnapshotId === profile.profileSnapshotId &&
        master.profileId === plan.profile.id && master.profileVersion === plan.profile.version &&
        master.consentSnapshotHash === plan.profile.consent.snapshotHash &&
        master.scriptHash === plan.audio.scriptHash && master.scriptText === sourceBlock!.text &&
        master.durationMs === plan.durationMs && master.locale === plan.locale &&
        Boolean(providerOriginal) && Boolean(finalAudio) && Boolean(alignment) &&
        providerOriginal!.artifactId === consumption.sourceArtifactId &&
        providerOriginal!.sha256 === consumption.sourceArtifactSha256 &&
        providerOriginal!.artifactId === sourceBlock!.artifact.artifactId &&
        providerOriginal!.sha256 === sourceBlock!.artifact.sha256 &&
        finalAudio!.artifactId === plan.audio.artifactId && finalAudio!.sha256 === plan.audio.sha256 &&
        alignment!.sha256 === master.alignmentHash &&
        decision.candidateMasterId === master.id &&
        decision.criticReportHash === master.critic.reportHash &&
        sourceBlock!.critic.id === master.critic.reportId &&
        sourceBlock!.critic.resultHash === master.critic.reportHash,
      'VERSION_CONFLICT',
      'Canonical reused master, plan, artifacts or critic changed before commit',
    )

    const [persistedSourceJob, report, head, artifactRows] = await Promise.all([
      jobs.readById({ workspaceId: plan.workspaceId, jobId: consumption.sourceProviderJobId }),
      critics.readByHash({ workspaceId: plan.workspaceId, reportHash: master.critic.reportHash }),
      transaction.v2SyntheticPresenterProfileHead.findUnique({
        where: { workspaceId_profileId: { workspaceId: plan.workspaceId, profileId: master.profileId } },
        include: { currentSnapshot: true },
      }),
      transaction.v2MediaArtifact.findMany({
        where: {
          workspaceId: plan.workspaceId,
          id: { in: master.artifacts.map(({ artifactId }) => artifactId) },
          status: 'available',
        },
        include: { currentRightsSnapshot: true },
      }),
    ])
    assertDomain(Boolean(persistedSourceJob) && Boolean(report) && Boolean(head), 'VERSION_CONFLICT', 'Canonical reuse lineage changed before commit')
    const source = persistedSourceJob!.job
    const currentProfile = hydrateSyntheticPresenterProfile(head!.currentSnapshot)
    assertSyntheticPresenterPolicy({
      snapshot: profile.snapshot,
      snapshotWorkspaceId: plan.workspaceId,
      head: { currentVersion: head!.currentVersion, current: currentProfile.snapshot },
      context: {
        operation: 'audio-avatar',
        use: plan.use,
        market: plan.market,
        locale: plan.locale,
        workspaceId: plan.workspaceId,
        now: new Date(),
      },
    })
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]))
    assertDomain(
      artifactRows.length === new Set(master.artifacts.map(({ artifactId }) => artifactId)).size &&
        master.artifacts.every((artifact) => {
          const row = artifactsById.get(artifact.artifactId)
          if (!row || row.sha256 !== artifact.sha256 || Number(row.byteSize) !== artifact.byteSize ||
            row.mediaType !== artifact.mediaType || row.container !== artifact.container) return false
          const rights = row.currentRightsSnapshot ? hydrateAssetRights(row.currentRightsSnapshot) : null
          return evaluateAssetUse(rights, {
            workspaceId: plan.workspaceId,
            use: plan.use,
            market: plan.market,
            locale: plan.locale,
            syntheticOperations: ['audio-avatar'],
          }, new Date()).outcome === 'allow'
        }) &&
        source.id === master.provenance.providerJobId && source.status === 'approved' &&
        source.projectId === master.projectId && source.originProjectVersionId === master.projectVersionId &&
        source.criticResultHash === master.critic.reportHash &&
        source.resultArtifact?.artifactId === providerOriginal!.artifactId &&
        source.resultArtifact.artifactSha256 === providerOriginal!.sha256 &&
        source.authorization.profileSnapshotId === master.profileSnapshotId &&
        report!.id === master.critic.reportId && report!.providerJobId === source.id &&
        report!.projectId === master.projectId && report!.profileSnapshotId === master.profileSnapshotId &&
        report!.artifactId === providerOriginal!.artifactId && report!.artifactSha256 === providerOriginal!.sha256 &&
        report!.scriptHash === master.scriptHash && isCurrentSyntheticCriticApproval(report!),
      'ASSET_RIGHTS_BLOCKED',
      'Canonical reused master lost current authority or exact worker approval before commit',
    )
    return Object.freeze({ decision, consumption })
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
    return row ? hydrateSyntheticPresenterProfile(row) : null
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
        // The head always points at the newest immutable version. Strict
        // sequencing above makes the guarded update a real compare-and-swap.
        if (input.snapshot.version === 1) {
          await transaction.v2SyntheticPresenterProfileHead.create({
            data: {
              workspaceId: input.workspaceId,
              profileId: input.snapshot.id,
              currentVersion: 1,
              currentSnapshotId: row.id,
              createdAt: new Date(input.createdAt),
              updatedAt: new Date(input.createdAt),
            },
          })
        } else {
          const advanced = await transaction.v2SyntheticPresenterProfileHead.updateMany({
            where: {
              workspaceId: input.workspaceId,
              profileId: input.snapshot.id,
              currentVersion: input.snapshot.version - 1,
            },
            data: {
              currentVersion: input.snapshot.version,
              currentSnapshotId: row.id,
              updatedAt: new Date(input.createdAt),
            },
          })
          if (advanced.count !== 1) {
            throw new DomainError('VERSION_CONFLICT', 'Synthetic presenter head advanced concurrently')
          }
        }
        return Object.freeze({ profile: hydrateSyntheticPresenterProfile(row), replayed: false })
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
    return row ? hydrateSyntheticPresenterProfile(row) : null
  }

  private hydrateHead(row: {
    workspaceId: string
    profileId: string
    currentVersion: number
    currentSnapshotId: string
    createdAt: Date
    updatedAt: Date
    currentSnapshot: V2SyntheticPresenterProfile
  }) {
    return Object.freeze({
      head: Object.freeze({
        workspaceId: row.workspaceId,
        profileId: row.profileId,
        currentVersion: row.currentVersion,
        currentSnapshotId: row.currentSnapshotId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
      current: hydrateSyntheticPresenterProfile(row.currentSnapshot),
    })
  }

  async listProfileHeads(input: { workspaceId: string }) {
    const rows = await this.prisma.v2SyntheticPresenterProfileHead.findMany({
      where: { workspaceId: input.workspaceId },
      include: { currentSnapshot: true },
      orderBy: [{ updatedAt: 'desc' }, { profileId: 'asc' }],
    })
    return Object.freeze(rows.map((row) => this.hydrateHead(row)))
  }

  async readProfileHead(input: { workspaceId: string; profileId: string }) {
    const row = await this.prisma.v2SyntheticPresenterProfileHead.findUnique({
      where: { workspaceId_profileId: { workspaceId: input.workspaceId, profileId: input.profileId } },
      include: { currentSnapshot: true },
    })
    return row ? this.hydrateHead(row) : null
  }

  async listProfileVersions(input: { workspaceId: string; profileId: string }) {
    const rows = await this.prisma.v2SyntheticPresenterProfile.findMany({
      where: { workspaceId: input.workspaceId, profileId: input.profileId },
      orderBy: { version: 'asc' },
    })
    return Object.freeze(rows.map(hydrateSyntheticPresenterProfile))
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
      include: { assets: { orderBy: { ordinal: 'asc' } }, audioMaster: true },
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
        const canonical = await this.validateCanonicalAudioAndReuse(
          transaction,
          input,
          hydrateSyntheticPresenterProfile(profile),
        )
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
            audioMasterId: input.audioMaster.id,
            audioMasterHash: input.audioMaster.masterHash,
            audioOriginProjectId: input.audioMaster.originProjectId,
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
        if (canonical) {
          await transaction.v2SyntheticCacheDecision.create({
            data: cacheDecisionData(canonical.decision),
          })
          const consumption = canonical.consumption
          await transaction.v2SyntheticMasterConsumption.create({
            data: {
              id: consumption.id,
              workspaceId: consumption.workspaceId,
              consumerProjectId: consumption.consumerProjectId,
              consumerProjectVersionId: consumption.consumerProjectVersionId,
              productionRunId: consumption.productionRunId,
              sourceMasterId: consumption.sourceMasterId,
              sourceMasterHash: consumption.sourceMasterHash,
              sourceProjectId: consumption.sourceProjectId,
              sourceProjectVersionId: consumption.sourceProjectVersionId,
              sourceProviderJobId: consumption.sourceProviderJobId,
              sourceArtifactId: consumption.sourceArtifactId,
              sourceArtifactSha256: consumption.sourceArtifactSha256,
              cacheDecisionId: consumption.cacheDecisionId,
              cacheDecisionHash: consumption.cacheDecisionHash,
              productionPlanHash: consumption.productionPlanHash,
              observationOpenedAt: new Date(consumption.observationOpenedAt),
              schemaVersion: consumption.schemaVersion,
              consumptionHash: consumption.consumptionHash,
              createdAt: new Date(consumption.createdAt),
            },
          })
        }
        const row = await transaction.v2SyntheticProductionRun.findUniqueOrThrow({
          where: { id: plan.id },
          include: { assets: { orderBy: { ordinal: 'asc' } }, audioMaster: true },
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
      include: { assets: { orderBy: { ordinal: 'asc' } }, audioMaster: true },
    })
    return row ? hydrateRun(row) : null
  }
}
