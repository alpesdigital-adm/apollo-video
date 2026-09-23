import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import { isCurrentSyntheticCriticApproval } from '../../application/synthetic-critic.ts'
import type {
  SyntheticCatalogueEvidence,
  SyntheticCrossProjectReuseEvidence,
  SyntheticPhaseGateEvidenceReader,
  SyntheticPhaseGateEvidenceReference,
  SyntheticPhaseGateEvidenceSources,
  SyntheticProviderExecutionEvidence,
  SyntheticProviderSwapEvidence,
  SyntheticTransformationEvidence,
} from '../../application/ports/synthetic-phase-gate-evidence-reader.ts'
import type { SyntheticPhaseGateEvidenceQuery } from '../../application/ports/synthetic-phase-gate-repository.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticCacheDecisionIntegrity,
  SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
  type SyntheticCacheDecision,
} from '../../domain/synthetic-cache-decision.ts'
import {
  assertSyntheticMasterConsumptionIntegrity,
  SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION,
  type SyntheticMasterConsumption,
} from '../../domain/synthetic-master-consumption.ts'
import { resolveSyntheticCriticThresholds } from '../../domain/synthetic-critic-thresholds.ts'
import { assertSyntheticPresenterPolicy } from '../../domain/synthetic-presenter-policy-engine.ts'
import { PrismaProviderExecutionProvenanceRepository } from './provider-execution-provenance-repository.ts'
import { PrismaProviderJobRepository } from './provider-job-repository.ts'
import { PrismaProviderResultArtifactRepository } from './provider-result-artifact-repository.ts'
import { PrismaProtectedRenderInputStore } from './protected-render-input-store.ts'
import { PrismaSyntheticAudioMasterRepository } from './synthetic-audio-master-repository.ts'
import { PrismaSyntheticCriticReportRepository } from './synthetic-critic-report-repository.ts'
import { PrismaSyntheticMasterAssetRepository } from './synthetic-master-asset-repository.ts'
import { PrismaSyntheticProductionRepository } from './synthetic-production-repository.ts'
import { PrismaSyntheticProductionRenderRepository } from './synthetic-production-render-repository.ts'
import { PrismaSyntheticSpeechSegmentRepository } from './synthetic-speech-segment-repository.ts'
import { PrismaTransformationQualityRepository } from './transformation-quality-repository.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { createProtectedPayloadCipherFromEnvironment } from '../security/recipe-parameter-cipher.ts'

type ReaderClient = PrismaClient | Prisma.TransactionClient

function asPrismaClient(client: ReaderClient): PrismaClient {
  return client as unknown as PrismaClient
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function usesCurrentCriticPolicy(report: {
  capability: string
  adapterId: string
  thresholdsVersion: string
  expectationHash?: string
  evaluationContextHash?: string
}): boolean {
  if (!report.expectationHash || !report.evaluationContextHash) return false
  if (report.capability !== 'tts' && report.capability !== 'audio-avatar') return false
  try {
    return resolveSyntheticCriticThresholds({
      capability: report.capability,
      adapterId: report.adapterId,
    }).version === report.thresholdsVersion
  } catch {
    return false
  }
}

function isCorruptSource(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
}

async function omitCorruptSource<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isCorruptSource(error)) return null
    throw error
  }
}

async function actorIsCurrent(
  client: ReaderClient,
  query: Readonly<SyntheticPhaseGateEvidenceQuery>,
  at: Date,
) {
  const audit = query.authenticationAudit
  if (audit.workspaceId !== query.workspaceId) return false
  const recomputed = createApiAccessAuditContext({
    clientId: audit.clientId,
    credentialId: audit.credentialId,
    workspaceId: audit.workspaceId,
    environment: audit.environment,
    authenticationKind: audit.authenticationKind,
    ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}),
    ...(audit.delegatedIdentityId ? { delegatedIdentityId: audit.delegatedIdentityId } : {}),
    ...(audit.workspaceRole ? { workspaceRole: audit.workspaceRole } : {}),
  })
  if (recomputed.contextHash !== audit.contextHash) return false
  const sessionHash = audit.authenticationKind === 'ui-session' &&
      audit.credentialId.startsWith('ui-session:')
    ? audit.credentialId.slice('ui-session:'.length)
    : null
  const [workspace, actor, credential, session] = await Promise.all([
    client.v2Workspace.findUnique({ where: { id: query.workspaceId } }),
    client.v2ApiClient.findFirst({
      where: { id: audit.clientId, workspaceId: query.workspaceId },
    }),
    audit.authenticationKind === 'bearer'
      ? client.v2ApiCredential.findFirst({
          where: {
            id: audit.credentialId,
            clientId: audit.clientId,
            workspaceId: query.workspaceId,
          },
        })
      : Promise.resolve(null),
    sessionHash
      ? client.v2UiSession.findFirst({
          where: {
            nonceHash: sessionHash,
            workspaceId: query.workspaceId,
            clientId: audit.clientId,
            memberId: audit.delegatedUserId,
            revokedAt: null,
            idleExpiresAt: { gt: at },
            expiresAt: { gt: at },
            member: {
              status: 'active',
              role: audit.workspaceRole,
              identityId: audit.delegatedIdentityId,
              identity: { status: 'active' },
            },
          },
        })
      : Promise.resolve(null),
  ])
  if (
    !workspace || workspace.status !== 'active' ||
    workspace.apiAccessStatus !== 'active' || workspace.apiKillSwitchEngaged ||
    !actor || actor.status !== 'active' || actor.apiKillSwitchEngaged
  ) return false
  let environments: unknown
  let scopes: unknown
  try {
    environments = JSON.parse(actor.allowedEnvironmentsJson)
    scopes = JSON.parse(actor.scopeGrantsJson)
  } catch {
    return false
  }
  if (
    !Array.isArray(environments) || !environments.includes(audit.environment) ||
    !Array.isArray(scopes) || !scopes.includes('projects:write')
  ) return false
  if (
    audit.authenticationKind === 'bearer' &&
    (!credential || credential.status !== 'active' || credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt.getTime() <= at.getTime()))
  ) return false
  if (audit.authenticationKind === 'ui-session' && !session) return false
  if (audit.delegatedUserId || audit.delegatedIdentityId || audit.workspaceRole) {
    if (!audit.delegatedUserId || !audit.delegatedIdentityId || !audit.workspaceRole) return false
    const member = await client.v2WorkspaceMember.findFirst({
      where: {
        id: audit.delegatedUserId,
        identityId: audit.delegatedIdentityId,
        workspaceId: query.workspaceId,
        role: audit.workspaceRole,
        status: 'active',
      },
    })
    if (!member) return false
  }
  return true
}

interface VerifiedExecution {
  jobId: string
  operation: 'tts' | 'audio-avatar'
  adapterId: string
  adapterVersion: string
  projectVersionId: string
  profileSnapshotId: string
  runtimeClass: 'controlled' | 'live'
  passed: boolean
  references: SyntheticProviderExecutionEvidence['references']
  input: Readonly<Record<string, unknown>>
}

async function readExecution(
  client: ReaderClient,
  workspaceId: string,
  projectId: string,
  jobId: string,
  now: Date,
): Promise<Readonly<VerifiedExecution> | null> {
  try {
    const prisma = asPrismaClient(client)
    const jobs = new PrismaProviderJobRepository(prisma)
    const provenance = new PrismaProviderExecutionProvenanceRepository(prisma)
    const results = new PrismaProviderResultArtifactRepository(prisma)
    const critics = new PrismaSyntheticCriticReportRepository(prisma)
    const [stored, receipt, evidence, resultRecords] = await Promise.all([
      jobs.readById({ workspaceId, jobId }),
      provenance.readReceiptByJob({ workspaceId, projectId, jobId }),
      provenance.listEvidenceByJob({ workspaceId, projectId, jobId }),
      results.listByJob({ workspaceId, projectId, jobId }),
    ])
    if (!stored || !receipt || stored.job.projectId !== projectId) return null
    const job = stored.job
    if (job.operation !== 'tts' && job.operation !== 'audio-avatar') return null
    if (
      receipt.workspaceId !== workspaceId || receipt.projectId !== projectId ||
      receipt.jobId !== job.id || receipt.attempt !== job.attempt ||
      receipt.adapterId !== job.adapterId || receipt.adapterVersion !== job.adapterVersion ||
      receipt.inputHash !== job.inputHash ||
      receipt.authorizationHash !== job.authorization.authorizationHash ||
      receipt.providerJobRef !== job.providerJobId
    ) return null
    const submit = evidence.find((item) => item.id === receipt.submitEvidenceId)
    const retrieve = receipt.retrieveEvidenceId
      ? evidence.find((item) => item.id === receipt.retrieveEvidenceId)
      : undefined
    const commonEvidence = (item: typeof evidence[number] | undefined) => Boolean(
      item && item.workspaceId === workspaceId && item.projectId === projectId &&
      item.jobId === job.id && item.attempt === receipt.attempt &&
      item.runtimeClass === receipt.runtimeClass &&
      item.adapterId === job.adapterId && item.adapterVersion === job.adapterVersion &&
      item.adapterConfigHash === receipt.adapterConfigHash &&
      item.inputHash === job.inputHash && item.authorizationHash === job.authorization.authorizationHash &&
      item.providerJobRef === receipt.providerJobRef,
    )
    if (
      !commonEvidence(submit) || submit!.phase !== 'submit' ||
      submit!.evidenceHash !== receipt.submitEvidenceHash ||
      (job.operation === 'audio-avatar' && (
        !commonEvidence(retrieve) || retrieve!.phase !== 'retrieve' ||
        retrieve!.evidenceHash !== receipt.retrieveEvidenceHash
      ))
    ) return null
    const byId = new Map(resultRecords.map((item) => [item.id, item]))
    if (receipt.results.length !== resultRecords.length) return null
    for (const item of receipt.results) {
      const result = byId.get(item.resultRecordId)
      if (
        !result || !result.recordHash || result.recordHash !== item.resultRecordHash ||
        result.role !== item.role || result.artifactId !== item.artifactId ||
        result.artifactSha256 !== item.artifactSha256 || result.byteSize !== item.byteSize ||
        result.providerJobRef !== receipt.providerJobRef ||
        result.inputHash !== job.inputHash ||
        result.authorizationHash !== job.authorization.authorizationHash ||
        result.adapterId !== job.adapterId || result.adapterVersion !== job.adapterVersion ||
        result.adapterConfigHash !== receipt.adapterConfigHash
      ) return null
    }
    const primaryRole = job.operation === 'tts' ? 'primary-audio' : 'primary-video'
    const primary = resultRecords.find((item) => item.role === primaryRole)
    const alignment = resultRecords.find((item) => item.role === 'alignment-evidence')
    if (
      !primary || !primary.recordHash ||
      job.resultArtifact?.artifactId !== primary.artifactId ||
      job.resultArtifact.artifactSha256 !== primary.artifactSha256 ||
      (job.operation === 'tts' && (!alignment || !alignment.recordHash))
    ) return null
    const report = job.criticResultHash
      ? await critics.readByHash({ workspaceId, reportHash: job.criticResultHash })
      : null
    if (
      !report || report.projectId !== projectId ||
      report.capability !== job.operation ||
      report.artifactId !== primary.artifactId ||
      report.artifactSha256 !== primary.artifactSha256 ||
      report.adapterId !== job.adapterId || report.adapterVersion !== job.adapterVersion ||
      !usesCurrentCriticPolicy(report)
    ) return null
    const input = record(job.input)
    if (!input) return null
    const criticBinding = record(input.criticBinding)
    const use = string(criticBinding?.use)
    const market = string(criticBinding?.market)
    const locale = string(criticBinding?.locale)
    if (!use || !market || !locale || report.profileSnapshotId !== job.authorization.profileSnapshotId) return null
    const profiles = new PrismaSyntheticProductionRepository(prisma)
    const snapshot = await profiles.readProfile({
      workspaceId,
      snapshotId: job.authorization.profileSnapshotId,
    })
    const head = snapshot
      ? await profiles.readProfileHead({ workspaceId, profileId: snapshot.snapshot.id })
      : null
    if (!snapshot || !head) return null
    assertSyntheticPresenterPolicy({
      snapshot: snapshot.snapshot,
      snapshotWorkspaceId: workspaceId,
      head: { currentVersion: head.head.currentVersion, current: head.current.snapshot },
      context: { operation: job.operation, use, market, locale, workspaceId, now },
    })
    const authorizedIds = new Set([
      ...job.authorization.artifactDecisions.map(({ artifactId }) => artifactId),
      ...resultRecords.map(({ artifactId }) => artifactId),
    ])
    const authorizedArtifacts = await client.v2MediaArtifact.findMany({
      where: { workspaceId, id: { in: [...authorizedIds] }, status: 'available' },
      include: { currentRightsSnapshot: true },
    })
    if (authorizedArtifacts.length !== authorizedIds.size) return null
    if (!authorizedArtifacts.every((artifact) => {
      const decision = evaluateAssetUse(
        artifact.currentRightsSnapshot
          ? hydrateAssetRights(artifact.currentRightsSnapshot)
          : null,
        {
          workspaceId,
          use,
          market,
          locale,
          syntheticOperations: [job.operation],
        },
        now,
      )
      return decision.outcome === 'allow'
    })) return null
    const references = [
      Object.freeze({ type: 'provider-job' as const, id: job.id, hash: job.jobHash }),
      ...resultRecords.map((item) => Object.freeze({
        type: 'provider-result-artifact' as const,
        id: item.id,
        hash: item.recordHash!,
      })),
      ...(alignment ? [Object.freeze({
        type: 'alignment-artifact' as const,
        id: alignment.artifactId,
        hash: alignment.artifactSha256,
      })] : []),
    ]
    return Object.freeze({
      jobId: job.id,
      operation: job.operation,
      adapterId: job.adapterId,
      adapterVersion: job.adapterVersion,
      projectVersionId: job.originProjectVersionId,
      profileSnapshotId: job.authorization.profileSnapshotId,
      runtimeClass: receipt.runtimeClass === 'live' && (
        job.operation === 'tts' || (
          report.outputSpeechEvidence?.speechEvidence.kind === 'measured' &&
          report.evaluators.every((evaluator) => evaluator.kind === 'measured')
        )
      ) ? 'live' : 'controlled',
      passed: job.status === 'approved' && isCurrentSyntheticCriticApproval({
        ...report,
        capability: job.operation,
      }),
      references: Object.freeze(references),
      input: Object.freeze(input),
    })
  } catch (error) {
    if (isCorruptSource(error)) return null
    throw error
  }
}

async function currentMasterAuthority(
  client: ReaderClient,
  master: Awaited<ReturnType<PrismaSyntheticMasterAssetRepository['read']>>,
  now: Date,
) {
  if (!master) return null
  try {
    const prisma = asPrismaClient(client)
    const profiles = new PrismaSyntheticProductionRepository(prisma)
    const jobs = new PrismaProviderJobRepository(prisma)
    const critics = new PrismaSyntheticCriticReportRepository(prisma)
    const [snapshot, head, job, report, artifacts] = await Promise.all([
      profiles.readProfile({ workspaceId: master.master.workspaceId, snapshotId: master.master.profileSnapshotId }),
      profiles.readProfileHead({ workspaceId: master.master.workspaceId, profileId: master.master.profileId }),
      jobs.readById({ workspaceId: master.master.workspaceId, jobId: master.master.provenance.providerJobId }),
      critics.readByHash({ workspaceId: master.master.workspaceId, reportHash: master.master.critic.reportHash }),
      client.v2MediaArtifact.findMany({
        where: {
          workspaceId: master.master.workspaceId,
          id: { in: master.master.artifacts.map(({ artifactId }) => artifactId) },
          status: 'available',
        },
        include: { currentRightsSnapshot: true },
      }),
    ])
    if (
      !snapshot || !head || !job || !report ||
      job.job.operation !== 'audio-avatar' ||
      report.capability !== job.job.operation
    ) return null
    if (!isCurrentSyntheticCriticApproval({ ...report, capability: job.job.operation })) return false
    const criticBinding = record(record(job.job.input)?.criticBinding)
    const audioRange = record(record(job.job.input)?.audioRange)
    const use = string(criticBinding?.use)
    const market = string(criticBinding?.market)
    const locale = string(criticBinding?.locale)
    if (!use || !market || !locale) return null
    assertSyntheticPresenterPolicy({
      snapshot: snapshot.snapshot,
      snapshotWorkspaceId: master.master.workspaceId,
      head: { currentVersion: head.head.currentVersion, current: head.current.snapshot },
      context: {
        operation: 'audio-avatar',
        use,
        market,
        locale,
        workspaceId: master.master.workspaceId,
        now,
      },
    })
    if (
      job.job.status !== 'approved' ||
      job.job.workspaceId !== master.master.workspaceId ||
      job.job.projectId !== master.master.projectId ||
      job.job.originProjectVersionId !== master.master.projectVersionId ||
      job.job.criticResultHash !== master.master.critic.reportHash ||
      job.job.adapterId !== master.master.provenance.adapterId ||
      job.job.adapterVersion !== master.master.provenance.adapterVersion ||
      job.job.operation !== master.master.provenance.capability ||
      job.job.providerJobId !== master.master.provenance.providerJobRef ||
      job.job.authorization.profileSnapshotId !== master.master.profileSnapshotId ||
      job.job.authorization.authorizationHash !== master.master.authorizationHash ||
      report.id !== master.master.critic.reportId ||
      report.projectId !== master.master.projectId ||
      report.profileSnapshotId !== master.master.profileSnapshotId ||
      report.scriptHash !== master.master.scriptHash
    ) return null
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const providerOriginal = master.master.artifacts.find(({ role }) => role === 'provider-original')
    const finalAudio = master.master.artifacts.find(({ role }) => role === 'final-audio')
    const alignment = master.master.artifacts.find(({ role }) => role === 'alignment')
    if (
      !providerOriginal || !finalAudio || !alignment ||
      job.job.resultArtifact?.artifactId !== providerOriginal.artifactId ||
      job.job.resultArtifact.artifactSha256 !== providerOriginal.sha256 ||
      report.artifactId !== providerOriginal.artifactId ||
      report.artifactSha256 !== providerOriginal.sha256 ||
      report.audioArtifactId !== null ||
      report.alignmentArtifactId !== alignment.artifactId ||
      !audioRange || audioRange.startMs !== 0 || audioRange.endMs !== master.master.durationMs ||
      !report.outputSpeechEvidence?.passed ||
      report.outputSpeechEvidence.sourceAudioArtifactId !== finalAudio.artifactId ||
      report.outputSpeechEvidence.sourceAudioRangeHash !== audioRange.rangeHash ||
      report.outputSpeechEvidence.sourceDurationMs !== master.master.durationMs ||
      report.outputSpeechEvidence.speechEvidence.outputTranscriptHash !== master.master.scriptHash ||
      report.outputSpeechEvidence.speechEvidence.observedIdentityRef !== snapshot.snapshot.avatar.identityRef
    ) return null
    if (
      artifacts.length !== new Set(master.master.artifacts.map(({ artifactId }) => artifactId)).size ||
      master.master.artifacts.some((artifact) => {
        const current = artifactsById.get(artifact.artifactId)
        return !current || current.sha256 !== artifact.sha256 ||
          Number(current.byteSize) !== artifact.byteSize ||
          current.mediaType !== artifact.mediaType || current.container !== artifact.container
      })
    ) return null
    return master.master.artifacts.every((artifact) => {
        const current = artifactsById.get(artifact.artifactId)!
        const decision = evaluateAssetUse(current.currentRightsSnapshot
          ? hydrateAssetRights(current.currentRightsSnapshot)
          : null, {
          workspaceId: master.master.workspaceId,
          use,
          market,
          locale,
          syntheticOperations: ['audio-avatar'],
        }, now)
        return decision.outcome === 'allow'
      })
  } catch (error) {
    if (isCorruptSource(error)) return null
    if (error instanceof DomainError) return false
    throw error
  }
}

function hydrateConsumption(row: Readonly<{
  id: string
  workspaceId: string
  consumerProjectId: string
  consumerProjectVersionId: string
  productionRunId: string
  sourceMasterId: string
  sourceMasterHash: string
  sourceProjectId: string
  sourceProjectVersionId: string
  sourceProviderJobId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  cacheDecisionId: string
  cacheDecisionHash: string
  productionPlanHash: string
  observationOpenedAt: Date
  schemaVersion: string
  consumptionHash: string
  createdAt: Date
}>): Readonly<SyntheticMasterConsumption> {
  if (row.schemaVersion !== SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic master consumption has an unknown schema version')
  }
  return assertSyntheticMasterConsumptionIntegrity(Object.freeze({
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
  }))
}

function hydrateCacheDecision(row: Readonly<{
  id: string
  workspaceId: string
  projectId: string
  schemaVersion: string
  operation: string
  cacheKey: string
  cacheKeyVersion: string
  outcome: string
  reasonCode: string
  reason: string
  candidateGenerationId: string | null
  candidateMasterId: string | null
  policyVersion: string
  criticReportHash: string | null
  estimatedSavingMinorUnits: number
  avoidedCostMinorUnits: number
  currency: string
  subjectHash: string
  decidedAt: Date
  decisionHash: string
}>): Readonly<SyntheticCacheDecision> {
  if (row.schemaVersion !== SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic cache decision has an unknown schema version')
  }
  return assertSyntheticCacheDecisionIntegrity(Object.freeze({
    schemaVersion: SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    operation: row.operation as SyntheticCacheDecision['operation'],
    cacheKey: row.cacheKey,
    cacheKeyVersion: row.cacheKeyVersion,
    outcome: row.outcome as SyntheticCacheDecision['outcome'],
    reasonCode: row.reasonCode as SyntheticCacheDecision['reasonCode'],
    reason: row.reason,
    candidateGenerationId: row.candidateGenerationId,
    candidateMasterId: row.candidateMasterId,
    policyVersion: row.policyVersion,
    criticReportHash: row.criticReportHash,
    estimatedSavingMinorUnits: row.estimatedSavingMinorUnits,
    avoidedCostMinorUnits: row.avoidedCostMinorUnits,
    currency: row.currency,
    subjectHash: row.subjectHash,
    decidedAt: row.decidedAt.toISOString(),
    decisionHash: row.decisionHash,
  }))
}

interface VerifiedReuseRender {
  completedAt: Date
  editPlan: SyntheticPhaseGateEvidenceReference
  renderManifest: SyntheticPhaseGateEvidenceReference
  buildAttestation: SyntheticPhaseGateEvidenceReference
  runtimeIdentityMatches: boolean
  assetsMatch: boolean
  propsHashMatches: boolean
  providerNeutral: boolean
}

async function readVerifiedReuseRender(
  client: ReaderClient,
  consumption: Readonly<SyntheticMasterConsumption>,
): Promise<Readonly<VerifiedReuseRender> | null> {
  const prisma = asPrismaClient(client)
  const protectedInputs = new PrismaProtectedRenderInputStore(
    prisma,
    createProtectedPayloadCipherFromEnvironment(),
  )
  const render = await new PrismaSyntheticProductionRenderRepository(
    prisma,
    protectedInputs,
  ).readLatestByRun({
    workspaceId: consumption.workspaceId,
    projectId: consumption.consumerProjectId,
    runId: consumption.productionRunId,
  })
  if (!render || render.context.outputKind !== 'final' ||
    render.operation.status !== 'succeeded' || render.operation.phase !== 'completed' ||
    !render.operation.completedAt || !render.checkpoint || !render.qualityReport || !render.attestation ||
    !render.qualityReport.passed ||
    render.context.projectVersionId !== consumption.consumerProjectVersionId ||
    render.context.planHash !== consumption.productionPlanHash ||
    Date.parse(consumption.createdAt) > Date.parse(render.operation.completedAt)) return null
  return Object.freeze({
    completedAt: new Date(render.operation.completedAt),
    editPlan: Object.freeze({
      type: 'edit-plan' as const,
      id: render.context.editPlanSnapshotId,
      hash: render.context.editPlanSnapshotHash,
    }),
    renderManifest: Object.freeze({
      type: 'render-manifest' as const,
      id: render.context.outputManifestId,
      hash: render.attestation.renderManifestHash,
    }),
    buildAttestation: Object.freeze({
      type: 'build-attestation' as const,
      id: render.attestation.id,
      hash: render.attestation.attestationHash,
    }),
    runtimeIdentityMatches: true,
    assetsMatch: true,
    propsHashMatches: true,
    providerNeutral: render.attestation.checks.some(
      (check) => check.code === 'provider-swap' && check.exitCode === 0,
    ),
  })
}

export class PrismaSyntheticPhaseGateEvidenceReader
implements SyntheticPhaseGateEvidenceReader {
  private readonly client: PrismaClient
  private readonly clock: () => Date

  constructor(client: PrismaClient, clock: () => Date = () => new Date()) {
    this.client = client
    this.clock = clock
  }

  async read(input: Readonly<SyntheticPhaseGateEvidenceQuery>) {
    return this.client.$transaction(
      (transaction) => this.readWithClient(transaction, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
  }

  async readWithClient(
    client: ReaderClient,
    input: Readonly<SyntheticPhaseGateEvidenceQuery>,
  ): Promise<Readonly<SyntheticPhaseGateEvidenceSources> | null> {
    const now = this.clock()
    const [project, actorCurrent] = await Promise.all([
      client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: { currentVersion: true },
      }),
      actorIsCurrent(client, input, now),
    ])
    if (!actorCurrent) throw new DomainError('AUTH_INVALID', 'Synthetic phase gate actor is no longer active')
    if (!project?.currentVersion) return null
    const projectVersion = project.currentVersion
    if (
      projectVersion.id !== input.projectVersionId ||
      projectVersion.baseHash !== input.projectVersionHash
    ) {
      return Object.freeze({
        projectVersionId: projectVersion.id,
        projectVersionHash: projectVersion.baseHash,
        providerExecutions: Object.freeze([]),
        catalogues: Object.freeze([]),
        reuses: Object.freeze([]),
        transformations: Object.freeze([]),
        swaps: Object.freeze([]),
      })
    }
    const prisma = asPrismaClient(client)
    const masterRepository = new PrismaSyntheticMasterAssetRepository(prisma)
    const segmentRepository = new PrismaSyntheticSpeechSegmentRepository(prisma)
    const resultRepository = new PrismaProviderResultArtifactRepository(prisma)
    const audioMasterRepository = new PrismaSyntheticAudioMasterRepository(prisma)
    const [jobRows, masterRows] = await Promise.all([
      client.v2ProviderJob.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          originProjectVersionId: projectVersion.id,
        },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      client.v2SyntheticMasterAsset.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId },
        select: { id: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
    ])
    const masters = (await Promise.all(masterRows.map(({ id }) =>
      omitCorruptSource(() => masterRepository.read({
        workspaceId: input.workspaceId,
        masterId: id,
      })))))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))

    const executions = (await Promise.all(jobRows.map(({ id }) =>
      readExecution(client, input.workspaceId, input.projectId, id, now))))
      .filter((value): value is Readonly<VerifiedExecution> => Boolean(value))
    const executionByJob = new Map(executions.map((execution) => [execution.jobId, execution]))
    const providerExecutions: SyntheticProviderExecutionEvidence[] = []
    for (const execution of executions) {
      if (execution.operation === 'tts' && execution.adapterId === 'elevenlabs-tts') {
        providerExecutions.push(Object.freeze({
          kind: 'elevenlabs-audio-alignment',
          runtimeClass: execution.runtimeClass,
          passed: execution.passed,
          references: execution.references,
        }))
        continue
      }
      if (execution.adapterId !== 'heygen-v3') continue
      const audioMasterId = string(execution.input.audioMasterId)
      if (!audioMasterId) continue
      const storedAudioMaster = await omitCorruptSource(() => audioMasterRepository.read({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        audioMasterId,
      }))
      if (!storedAudioMaster) continue
      const audioMaster = storedAudioMaster.master
      if (
        audioMaster.projectVersionId !== execution.projectVersionId ||
        audioMaster.profileSnapshotId !== execution.profileSnapshotId
      ) continue
      const audioRange = record(execution.input.audioRange)
      const rangeMatches = Boolean(
        execution.input.audioMasterHash === audioMaster.masterHash &&
        execution.input.audioArtifactId === audioMaster.audio.artifactId &&
        audioRange &&
        Number.isSafeInteger(audioRange.startMs) &&
        Number.isSafeInteger(audioRange.endMs) &&
        typeof audioRange.rangeHash === 'string' &&
        audioMaster.words.some((first, startWordIndex) =>
          first.startMs === audioRange.startMs &&
          audioMaster.words.some((last, endWordIndex) => {
            if (endWordIndex < startWordIndex || last.endMs !== audioRange.endMs) return false
            const selected = audioMaster.words.slice(startWordIndex, endWordIndex + 1)
            return calculateCanonicalHash({
              schemaVersion: 'synthetic-avatar-audio-range/v1',
              audioMasterId: audioMaster.id,
              audioMasterHash: audioMaster.masterHash,
              audioArtifactId: audioMaster.audio.artifactId,
              audioArtifactSha256: audioMaster.audio.artifactSha256,
              locale: audioMaster.audio.locale,
              startWordIndex,
              endWordIndex: endWordIndex + 1,
              startMs: first.startMs,
              endMs: last.endMs,
              durationMs: last.endMs - first.startMs,
              text: selected.map(({ word }) => word).join(' '),
            }) === audioRange.rangeHash
          }),
        ),
      )
      if (!rangeMatches) continue
      const masterReference = Object.freeze({
        type: 'synthetic-audio-master' as const,
        id: audioMaster.id,
        hash: audioMaster.masterHash,
      })
      if (audioMaster.source.kind === 'tts') {
        const tts = executionByJob.get(audioMaster.source.providerJobId)
        if (
          !tts || tts.operation !== 'tts' || tts.adapterId !== 'elevenlabs-tts' ||
          tts.projectVersionId !== audioMaster.projectVersionId ||
          tts.profileSnapshotId !== audioMaster.profileSnapshotId
        ) continue
        const ttsResultRecords = await omitCorruptSource(() => resultRepository.listByJob({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          jobId: tts.jobId,
        }))
        if (!ttsResultRecords) continue
        const audio = ttsResultRecords.find(({ role }) => role === 'primary-audio')
        const alignment = ttsResultRecords.find(({ role }) => role === 'alignment-evidence')
        if (
          !audio || !alignment ||
          audio.artifactId !== audioMaster.audio.artifactId ||
          audio.artifactSha256 !== audioMaster.audio.artifactSha256 ||
          alignment.artifactId !== audioMaster.alignmentEvidence.artifactId ||
          alignment.artifactSha256 !== audioMaster.alignmentEvidence.artifactSha256
        ) continue
        providerExecutions.push(Object.freeze({
          kind: 'heygen-generated-audio-avatar',
          runtimeClass: execution.runtimeClass === 'live' && tts.runtimeClass === 'live'
            ? 'live'
            : 'controlled',
          passed: execution.passed && tts.passed,
          references: Object.freeze([...execution.references, ...tts.references, masterReference]),
        }))
      } else if (audioMaster.source.kind === 'uploaded') {
        providerExecutions.push(Object.freeze({
          kind: 'heygen-ready-audio-avatar',
          runtimeClass: execution.runtimeClass,
          passed: execution.passed,
          references: Object.freeze([...execution.references, masterReference]),
        }))
      }
    }

    const catalogues: SyntheticCatalogueEvidence[] = []
    for (const storedMaster of masters) {
      const segmentRows = await client.v2SyntheticSpeechSegment.findMany({
        where: { workspaceId: input.workspaceId, masterId: storedMaster.master.id },
        select: { id: true },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      })
      const segments = (await Promise.all(segmentRows.map(({ id }) =>
        omitCorruptSource(() => segmentRepository.read({
          workspaceId: input.workspaceId,
          segmentId: id,
        })))))
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
      if (
        segments.length === 0 || segments.length !== segmentRows.length ||
        segments.some((segment) =>
          segment.masterId !== storedMaster.master.id ||
          segment.masterHash !== storedMaster.master.masterHash ||
          segment.criticReportHash !== storedMaster.master.critic.reportHash)
      ) continue
      const authority = await currentMasterAuthority(client, storedMaster, now)
      if (authority === null) continue
      catalogues.push(Object.freeze({
        master: Object.freeze({
          type: 'synthetic-master' as const,
          id: storedMaster.master.id,
          hash: storedMaster.master.masterHash,
        }),
        segments: Object.freeze(segments.map((segment) => Object.freeze({
          type: 'speech-segment' as const,
          id: segment.id,
          hash: segment.segmentHash,
        }))),
        currentAuthorityValid: authority,
      }))
    }

    const reuses: SyntheticCrossProjectReuseEvidence[] = []
    const swaps: SyntheticProviderSwapEvidence[] = []
    const consumptionRows = await client.v2SyntheticMasterConsumption.findMany({
      where: {
        workspaceId: input.workspaceId,
        sourceProjectId: input.projectId,
        sourceProjectVersionId: projectVersion.id,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
    for (const row of consumptionRows) {
      const consumption = await omitCorruptSource(async () => hydrateConsumption(row))
      if (!consumption) continue
      const [storedMaster, decisionRow, consumerProject, consumerVersion, render] = await Promise.all([
        omitCorruptSource(() => masterRepository.read({
          workspaceId: input.workspaceId,
          masterId: consumption.sourceMasterId,
        })),
        client.v2SyntheticCacheDecision.findFirst({
          where: {
            id: consumption.cacheDecisionId,
            workspaceId: input.workspaceId,
            projectId: consumption.consumerProjectId,
          },
        }),
        client.v2Project.findFirst({
          where: { id: consumption.consumerProjectId, workspaceId: input.workspaceId },
        }),
        client.v2ProjectVersion.findFirst({
          where: {
            id: consumption.consumerProjectVersionId,
            projectId: consumption.consumerProjectId,
            workspaceId: input.workspaceId,
          },
        }),
        omitCorruptSource(() => readVerifiedReuseRender(client, consumption)),
      ])
      if (!storedMaster || !decisionRow || !consumerProject || !consumerVersion || !render) continue
      const decision = await omitCorruptSource(async () => hydrateCacheDecision(decisionRow))
      if (!decision ||
        storedMaster.master.id !== consumption.sourceMasterId ||
        storedMaster.master.masterHash !== consumption.sourceMasterHash ||
        storedMaster.master.projectId !== input.projectId ||
        storedMaster.master.projectVersionId !== projectVersion.id ||
        storedMaster.master.provenance.providerJobId !== consumption.sourceProviderJobId ||
        !storedMaster.master.artifacts.some(({ role, artifactId, sha256 }) =>
          role === 'provider-original' && artifactId === consumption.sourceArtifactId &&
          sha256 === consumption.sourceArtifactSha256) ||
        decision.id !== consumption.cacheDecisionId ||
        decision.decisionHash !== consumption.cacheDecisionHash ||
        decision.projectId !== consumption.consumerProjectId ||
        decision.outcome !== 'hit' ||
        decision.reasonCode !== 'CACHE_HIT_ELIGIBLE' ||
        decision.candidateMasterId !== consumption.sourceMasterId ||
        decision.criticReportHash !== storedMaster.master.critic.reportHash ||
        consumerProject.createdAt.toISOString() !== consumption.observationOpenedAt ||
        Date.parse(consumption.createdAt) < consumerProject.createdAt.getTime()) continue
      const authority = await currentMasterAuthority(client, storedMaster, now)
      if (authority !== true) continue
      const closedAt = render.completedAt
      const [providerJobs, reservations, submits] = await Promise.all([
        client.v2ProviderJob.count({
          where: {
            workspaceId: input.workspaceId,
            projectId: consumption.consumerProjectId,
            createdAt: { lte: closedAt },
          },
        }),
        client.v2DirectorBudgetReservation.count({
          where: {
            workspaceId: input.workspaceId,
            projectId: consumption.consumerProjectId,
            createdAt: { lte: closedAt },
          },
        }),
        client.v2ProviderTransportEvidence.count({
          where: {
            workspaceId: input.workspaceId,
            projectId: consumption.consumerProjectId,
            phase: 'submit',
            observedAt: { lte: closedAt },
          },
        }),
      ])
      const providerWorkCount = providerJobs + reservations + submits
      reuses.push(Object.freeze({
        decision: Object.freeze({
          type: 'cache-decision' as const,
          id: decision.id,
          hash: decision.decisionHash,
        }),
        master: Object.freeze({
          type: 'synthetic-master' as const,
          id: storedMaster.master.id,
          hash: storedMaster.master.masterHash,
        }),
        consumerProject: Object.freeze({
          type: 'project' as const,
          id: consumption.consumerProjectId,
          hash: consumerVersion.baseHash,
        }),
        sourceProjectId: input.projectId,
        consumerProjectId: consumption.consumerProjectId,
        providerWorkCount,
        consumedByProduction: true,
      }))
      swaps.push(Object.freeze({
        editPlan: render.editPlan,
        renderManifest: render.renderManifest,
        buildAttestation: render.buildAttestation,
        runtimeIdentityMatches: render.runtimeIdentityMatches,
        assetsMatch: render.assetsMatch,
        propsHashMatches: render.propsHashMatches,
        providerNeutral: render.providerNeutral,
      }))
    }

    const transformations: SyntheticTransformationEvidence[] = []
    const transformationQuality = new PrismaTransformationQualityRepository(prisma)
    const ledgers = await transformationQuality.listFallbackLedgers({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 100,
    })
    for (const ledger of ledgers) {
      if (ledger.projectVersionId !== projectVersion.id) continue
      const rejected = ledger.attempts.find((attempt) =>
        attempt.rung === 'video-to-video' && attempt.outcome === 'rejected' &&
        attempt.providerJobId && attempt.criticReportHash)
      const approved = ledger.attempts.find((attempt) =>
        attempt.rung === 'generated-cutaway' && attempt.outcome === 'approved' &&
        attempt.providerJobId && attempt.artifactId && attempt.artifactSha256)
      if (!rejected?.providerJobId || !rejected.criticReportHash ||
        !approved?.providerJobId || !approved.artifactId || !approved.artifactSha256) continue
      const [rejectedReport, fallbackJob, fallbackResults, dispatchClaim] = await Promise.all([
        omitCorruptSource(() => transformationQuality.readCriticReportByJob({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          providerJobId: rejected.providerJobId!,
        })),
        omitCorruptSource(() => new PrismaProviderJobRepository(prisma).readById({
          workspaceId: input.workspaceId,
          jobId: approved.providerJobId!,
        })),
        omitCorruptSource(() => resultRepository.listByJob({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          jobId: approved.providerJobId!,
        })),
        client.v2TransformationFallbackDispatchClaim.findFirst({
          where: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            providerJobId: approved.providerJobId,
            outcome: 'enqueued',
            settledAt: { not: null },
          },
        }),
      ])
      const fallbackResult = fallbackResults?.find((result) =>
        result.artifactId === approved.artifactId &&
        result.artifactSha256 === approved.artifactSha256 &&
        result.mediaType === 'video' && result.recordHash)
      const fallback = fallbackJob?.job.transformation?.fallback
      const rejectedBeforeFallback = Boolean(
        rejectedReport && rejectedReport.reportHash === rejected.criticReportHash &&
        rejectedReport.providerJobId === rejected.providerJobId &&
        rejectedReport.decision === 'rejected' &&
        Date.parse(rejectedReport.evaluatedAt) <= Date.parse(ledger.updatedAt),
      )
      const fallbackApproved = Boolean(
        fallbackJob?.job.status === 'approved' && fallbackResult && dispatchClaim &&
        fallback?.rung === 'generated-cutaway' &&
        fallback.ledgerId === dispatchClaim.requestedLedgerId &&
        fallback.ledgerHash === dispatchClaim.requestedLedgerHash &&
        fallback.rejectedJobId === rejected.providerJobId &&
        fallback.rejectedReportHash === rejected.criticReportHash &&
        ledger.bestArtifactId === approved.artifactId &&
        ledger.bestArtifactSha256 === approved.artifactSha256,
      )
      transformations.push(Object.freeze({
        ledger: Object.freeze({
          type: 'transformation-fallback-ledger' as const,
          id: ledger.id,
          hash: ledger.ledgerHash,
        }),
        ...(rejectedReport ? { rejectedReport: Object.freeze({
          type: 'transformation-critic-report' as const,
          id: rejectedReport.id,
          hash: rejectedReport.reportHash,
        }) } : {}),
        ...(fallbackResult?.recordHash ? { approvedResult: Object.freeze({
          type: 'provider-result-artifact' as const,
          id: fallbackResult.id,
          hash: fallbackResult.recordHash,
        }) } : {}),
        rejectedBeforeFallback,
        fallbackApproved,
      }))
    }

    return Object.freeze({
      projectVersionId: projectVersion.id,
      projectVersionHash: projectVersion.baseHash,
      providerExecutions: Object.freeze(providerExecutions),
      catalogues: Object.freeze(catalogues),
      reuses: Object.freeze(reuses),
      transformations: Object.freeze(transformations),
      swaps: Object.freeze(swaps),
    })
  }
}
