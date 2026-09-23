import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient, type V2SyntheticBuildAttestation, type V2SyntheticProductionRenderOperation, type V2SyntheticProductionRenderQualityReport } from '../../../../generated/prisma-v2/index.js'

import type { SyntheticProductionRenderRepository } from '../../application/ports/synthetic-production-render-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { assertSyntheticBuildAttestation, calculateSyntheticBuildIdentityHash, type SyntheticBuildAttestation } from '../../domain/synthetic-build-attestation.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticProductionRenderCheckpoint,
  assertSyntheticProductionRenderContext,
  assertSyntheticProductionRenderQualityReport,
  type SyntheticProductionRenderCheckpoint,
  type SyntheticProductionRenderQualityReport,
} from '../../domain/synthetic-production-render.ts'
import { assertSyntheticPresenterEditPlan, type SyntheticPresenterEditPlan } from '../../domain/synthetic-production.ts'
import { assertSyntheticPresenterPolicy } from '../../domain/synthetic-presenter-policy-engine.ts'
import { hydrateSyntheticPresenterProfile } from './synthetic-production-repository.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import type { ProtectedRenderInputStore } from '../../application/ports/protected-render-input-store.ts'
import { assertRenderInputSpec, type RenderInputSpecV1 } from '../../domain/render-input.ts'
import { assertProviderJob, type ProviderJob } from '../../domain/provider-job.ts'
import { assertSyntheticCriticReportIntegrity, type SyntheticCriticReport } from '../../domain/synthetic-critic-report.ts'
import { isCurrentSyntheticCriticApproval } from '../../application/synthetic-critic.ts'
import { succeedPublicOperation } from '../../domain/public-operation.ts'
import {
  hydratePublicOperationRecord,
  OPERATION_INCLUDE,
  persistOperationStatusEvents,
} from './public-operation-repository.ts'

type AuthorityClient = Prisma.TransactionClient | PrismaClient

function parsePlan(value: string): Readonly<SyntheticPresenterEditPlan> {
  const parsed = parseRecord(value, 'synthetic production plan') as unknown as SyntheticPresenterEditPlan
  assertSyntheticPresenterEditPlan(parsed)
  return parsed
}

async function readHistoricalSyntheticRenderPlan(
  client: AuthorityClient,
  row: Readonly<V2SyntheticProductionRenderOperation>,
): Promise<Readonly<SyntheticPresenterEditPlan>> {
  const run = await client.v2SyntheticProductionRun.findFirst({
    where: {
      id: row.productionRunId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      projectVersionId: row.projectVersionId,
      editPlanSnapshotId: row.editPlanSnapshotId,
      planHash: row.planHash,
      editPlanSnapshot: { contentHash: row.editPlanSnapshotHash, kind: 'edit-plan' },
    },
  })
  if (!run) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render lost its immutable production source')
  const plan = parsePlan(run.planJson)
  if (plan.planHash !== row.planHash || plan.projectVersionId !== row.projectVersionId ||
    stableSerialize(plan) !== run.planJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render historical plan binding is invalid')
  }
  return plan
}

export async function assertCurrentSyntheticRenderAuthority(
  client: AuthorityClient,
  row: Readonly<V2SyntheticProductionRenderOperation>,
  now: Date,
): Promise<Readonly<SyntheticPresenterEditPlan>> {
  const run = await client.v2SyntheticProductionRun.findFirst({
    where: {
      id: row.productionRunId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      projectVersionId: row.projectVersionId,
      editPlanSnapshotId: row.editPlanSnapshotId,
      planHash: row.planHash,
      status: 'rendering',
      project: { currentVersionId: row.projectVersionId, currentVersion: { baseHash: row.projectVersionHash } },
      editPlanSnapshot: { contentHash: row.editPlanSnapshotHash, kind: 'edit-plan' },
    },
    include: {
      profileSnapshot: true,
      assets: true,
    },
  })
  if (!run) throw new DomainError('VERSION_CONFLICT', 'Synthetic render source is no longer current')
  const plan = parsePlan(run.planJson)
  if (
    plan.planHash !== run.planHash || plan.planHash !== row.planHash ||
    plan.projectVersionId !== row.projectVersionId || plan.profile.snapshotHash !== run.profileSnapshot.profileHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render plan lost its persisted authority binding')
  const snapshot = hydrateSyntheticPresenterProfile(run.profileSnapshot)
  const head = await client.v2SyntheticPresenterProfileHead.findUnique({
    where: { workspaceId_profileId: { workspaceId: row.workspaceId, profileId: snapshot.snapshot.id } },
    include: { currentSnapshot: true },
  })
  if (!head) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Synthetic presenter profile has no current authority')
  const current = hydrateSyntheticPresenterProfile(head.currentSnapshot)
  assertSyntheticPresenterPolicy({
    snapshot: snapshot.snapshot,
    snapshotWorkspaceId: row.workspaceId,
    head: { currentVersion: head.currentVersion, current: current.snapshot },
    context: {
      operation: 'audio-avatar',
      use: run.use,
      market: run.market,
      locale: run.locale,
      workspaceId: row.workspaceId,
      now,
    },
  })
  const artifacts = await client.v2MediaArtifact.findMany({
    where: { workspaceId: row.workspaceId, id: { in: run.assets.map((asset) => asset.artifactId) }, status: 'available' },
    include: { currentRightsSnapshot: true },
  })
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const planArtifactIds = [
    plan.audio.id,
    ...plan.blocks.map((block) => block.artifact.id),
    ...plan.bRoll.map((insert) => insert.artifact.id),
    ...plan.overlays.map((insert) => insert.artifact.id),
  ].toSorted()
  const authorizedArtifactIds = [...plan.authorization.artifactIds].toSorted()
  const persistedArtifactIds = run.assets.map((asset) => asset.artifactId).toSorted()
  if (new Set(planArtifactIds).size !== planArtifactIds.length ||
    stableSerialize(planArtifactIds) !== stableSerialize(authorizedArtifactIds) ||
    stableSerialize(planArtifactIds) !== stableSerialize(persistedArtifactIds) ||
    plan.authorization.decisions.length !== planArtifactIds.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render plan, assets and authorization set differ')
  }
  for (const asset of run.assets) {
    const artifact = byId.get(asset.artifactId)
    const authorized = plan.authorization.decisions.find((decision) => decision.artifactId === asset.artifactId)
    if (!artifact || artifact.sha256 !== asset.artifactSha256 || !authorized ||
      artifact.currentRightsSnapshotId !== authorized.rightsSnapshotId ||
      artifact.currentRightsSnapshot?.snapshotHash !== authorized.rightsSnapshotHash) {
      throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Synthetic render asset authority changed after enqueue')
    }
    const decision = evaluateAssetUse(artifact.currentRightsSnapshot
      ? hydrateAssetRights(artifact.currentRightsSnapshot)
      : null, {
      workspaceId: row.workspaceId,
      use: run.use,
      market: run.market,
      locale: run.locale,
      syntheticOperations: ['audio-avatar'],
    }, now)
    if (decision.outcome !== 'allow' || decision.validUntil !== authorized.validUntil) {
      throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Synthetic render asset rights are no longer valid')
    }
  }
  const jobIds = plan.blocks.map((block) => block.providerJobId)
  const reportHashes = plan.blocks.map((block) => block.critic.resultHash)
  const [jobRows, reportRows] = await Promise.all([
    client.v2ProviderJob.findMany({ where: { workspaceId: row.workspaceId, id: { in: jobIds } } }),
    client.v2SyntheticCriticReport.findMany({ where: { workspaceId: row.workspaceId, reportHash: { in: reportHashes } } }),
  ])
  const jobs = new Map(jobRows.map((stored) => {
    let job: ProviderJob
    try { job = JSON.parse(stored.jobJson) as ProviderJob } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render provider job is invalid JSON')
    }
    assertProviderJob(job)
    if (stableSerialize(job) !== stored.jobJson || job.jobHash !== stored.jobHash ||
      job.resultArtifact?.artifactId !== (stored.resultArtifactId ?? undefined) ||
      job.resultArtifact?.artifactSha256 !== (stored.resultArtifactSha256 ?? undefined) ||
      job.criticResultHash !== (stored.criticResultHash ?? undefined)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render provider job lost canonical integrity')
    }
    return [stored.id, job] as const
  }))
  const reports = new Map(reportRows.map((stored) => {
    let report: SyntheticCriticReport
    try { report = JSON.parse(stored.reportJson) as SyntheticCriticReport } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render critic report is invalid JSON')
    }
    assertSyntheticCriticReportIntegrity(report)
    if (stableSerialize(report) !== stored.reportJson || report.reportHash !== stored.reportHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render critic report lost canonical integrity')
    }
    return [stored.reportHash, report] as const
  }))
  for (const block of plan.blocks) {
    const asset = run.assets.find((candidate) => candidate.artifactId === block.artifact.id)
    const job = jobs.get(block.providerJobId)
    const report = reports.get(block.critic.resultHash)
    const binding = job?.input.criticBinding as Readonly<Record<string, unknown>> | undefined
    const audioRange = job?.input.audioRange as Readonly<Record<string, unknown>> | undefined
    if (!asset || asset.providerJobId !== block.providerJobId || asset.criticHash !== block.critic.resultHash ||
      !job || !report || !isCurrentSyntheticCriticApproval(report) ||
      job.status !== 'approved' || job.operation !== 'audio-avatar' || job.criticResultHash !== report.reportHash ||
      job.resultArtifact?.artifactId !== block.artifact.id || job.resultArtifact.artifactSha256 !== block.artifact.sha256 ||
      job.authorization.profileSnapshotId !== run.profileSnapshotId || job.input.audioArtifactId !== plan.audio.id ||
      audioRange?.startMs !== block.rangeMs[0] || audioRange.endMs !== block.rangeMs[1] ||
      report.providerJobId !== job.id || report.projectId !== job.projectId || report.blockId !== block.id ||
      report.capability !== 'audio-avatar' || report.artifactId !== block.artifact.id ||
      report.artifactSha256 !== block.artifact.sha256 || report.profileSnapshotId !== run.profileSnapshotId ||
      report.scriptHash !== binding?.scriptHash || binding.blockId !== block.id || binding.scriptText !== block.text ||
      report.outputSpeechEvidence?.sourceAudioArtifactId !== plan.audio.id ||
      report.outputSpeechEvidence.sourceAudioRangeHash !== audioRange.rangeHash) {
      throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic render block no longer has its exact current critic approval')
    }
  }
  return plan
}

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== value) {
      throw new Error('invalid')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateAttestation(row: Readonly<V2SyntheticBuildAttestation>): Readonly<SyntheticBuildAttestation> {
  const value = assertSyntheticBuildAttestation(
    parseRecord(row.attestationJson, 'synthetic build attestation') as unknown as SyntheticBuildAttestation,
  )
  if (stableSerialize(value) !== row.attestationJson || value.attestationHash !== row.attestationHash ||
    value.id !== row.id || value.workspaceId !== row.workspaceId || value.projectId !== row.projectId ||
    value.projectVersionId !== row.projectVersionId || value.projectVersionHash !== row.projectVersionHash ||
    value.productionRunId !== row.productionRunId || value.publicOperationId !== row.publicOperationId ||
    value.planSnapshotId !== row.planSnapshotId || value.planSnapshotHash !== row.planSnapshotHash ||
    value.renderManifestId !== row.renderManifestId || value.renderManifestHash !== row.renderManifestHash ||
    value.identity.commitSha !== row.runtimeCommitSha || value.identity.treeHash !== row.runtimeTreeHash ||
    value.identity.contractGraphHash !== row.runtimeContractGraphHash || value.identity.toolchainHash !== row.runtimeToolchainHash ||
    value.identity.renderBundleHash !== row.runtimeRenderBundleHash ||
    stableSerialize(value.checks) !== row.checksJson || value.startedAt !== row.startedAt.toISOString() ||
    value.completedAt !== row.completedAt.toISOString() || value.completedAt !== row.createdAt.toISOString()) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic build attestation lost canonical integrity')
  }
  return value
}

function qualityExpected(spec: Readonly<RenderInputSpecV1>) {
  assertRenderInputSpec(spec)
  return Object.freeze({
    width: spec.output.width,
    height: spec.output.height,
    fps: spec.output.fps,
    durationInFrames: spec.output.durationInFrames,
    codec: 'h264' as const,
    audioCodec: 'aac' as const,
    container: 'mp4' as const,
  })
}

function assertQualityBinding(
  row: Readonly<V2SyntheticProductionRenderOperation>,
  stored: Readonly<V2SyntheticProductionRenderQualityReport>,
  report: Readonly<SyntheticProductionRenderQualityReport>,
  storedCheckpoint: Readonly<SyntheticProductionRenderCheckpoint> | undefined,
  spec: Readonly<RenderInputSpecV1>,
): void {
  if (!storedCheckpoint || stableSerialize(report.expected) !== stableSerialize(qualityExpected(spec)) ||
    stableSerialize(report) !== stored.reportJson || report.reportHash !== stored.reportHash ||
    report.schemaVersion !== stored.schemaVersion || report.workspaceId !== stored.workspaceId ||
    report.projectId !== stored.projectId || report.projectVersionId !== stored.projectVersionId ||
    report.productionRunId !== stored.productionRunId || report.publicOperationId !== stored.operationId ||
    report.outputArtifactId !== stored.outputArtifactId || report.outputManifestId !== stored.outputManifestId ||
    report.passed !== stored.passed || report.evaluatedAt !== stored.evaluatedAt.toISOString() ||
    report.publicOperationId !== row.operationId || report.editPlanSnapshotId !== row.editPlanSnapshotId ||
    report.planHash !== row.planHash || report.renderInputHash !== row.renderInputHash ||
    report.propsHash !== row.propsHash || report.outputKind !== row.outputKind ||
    report.outputArtifactId !== row.outputArtifactId || report.outputManifestId !== row.outputManifestId ||
    report.outputSha256 !== storedCheckpoint.outputSha256 || report.byteSize !== storedCheckpoint.byteSize ||
    report.runtimeIdentityHash !== storedCheckpoint.runtimeIdentityHash ||
    report.measured.width !== storedCheckpoint.width || report.measured.height !== storedCheckpoint.height ||
    report.measured.fps !== storedCheckpoint.fps || report.measured.durationInFrames !== storedCheckpoint.durationInFrames ||
    report.measured.codec !== storedCheckpoint.codec || report.measured.audioCodec !== storedCheckpoint.audioCodec ||
    report.measured.container !== storedCheckpoint.container || !report.measured.decodable) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render quality report lost its canonical binding')
  }
}

async function assertAttestationBinding(
  client: AuthorityClient,
  row: Readonly<V2SyntheticProductionRenderOperation>,
  attestation: Readonly<SyntheticBuildAttestation>,
  storedCheckpoint: Readonly<SyntheticProductionRenderCheckpoint> | undefined,
): Promise<void> {
  if (!storedCheckpoint) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render attestation has no output checkpoint')
  const manifest = await client.v2MediaArtifactManifest.findFirst({
    where: {
      id: row.outputManifestId,
      workspaceId: row.workspaceId,
      artifactId: row.outputArtifactId,
      artifact: {
        status: 'available',
        sha256: storedCheckpoint.outputSha256,
        byteSize: BigInt(storedCheckpoint.byteSize),
        mediaType: 'video',
        container: 'mp4',
      },
    },
    select: { manifestHash: true },
  })
  if (!manifest || attestation.workspaceId !== row.workspaceId || attestation.projectId !== row.projectId ||
    attestation.projectVersionId !== row.projectVersionId || attestation.projectVersionHash !== row.projectVersionHash ||
    attestation.productionRunId !== row.productionRunId || attestation.publicOperationId !== row.operationId ||
    attestation.planSnapshotId !== row.editPlanSnapshotId || attestation.planSnapshotHash !== row.editPlanSnapshotHash ||
    attestation.renderManifestId !== row.outputManifestId || attestation.renderManifestHash !== manifest.manifestHash ||
    calculateSyntheticBuildIdentityHash(attestation.identity) !== storedCheckpoint.runtimeIdentityHash ||
    stableSerialize(attestation.identity) !== stableSerialize(storedCheckpoint.runtimeIdentity)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render build attestation lost its terminal binding')
  }
}

function checkpoint(row: Readonly<{
  operationId: string
  outputArtifactId: string
  outputKind: string
  renderInputHash: string
  checkpointAttempt: number | null
  checkpointOutputKey: string | null
  checkpointOutputSha256: string | null
  checkpointByteSize: bigint | null
  checkpointWidth: number | null
  checkpointHeight: number | null
  checkpointFps: number | null
  checkpointDurationFrames: number | null
  checkpointCodec: string | null
  checkpointAudioCodec: string | null
  checkpointContainer: string | null
  runtimeCommitSha: string | null
  runtimeTreeHash: string | null
  runtimeContractGraphHash: string | null
  runtimeToolchainHash: string | null
  runtimeRenderBundleHash: string | null
  runtimeIdentityHash: string | null
  checkpointCommittedAt: Date | null
  checkpointRecordedAt: Date | null
}>): Readonly<SyntheticProductionRenderCheckpoint> | undefined {
  const values = [
    row.checkpointAttempt, row.checkpointOutputKey, row.checkpointOutputSha256,
    row.checkpointByteSize, row.checkpointWidth, row.checkpointHeight,
    row.checkpointFps, row.checkpointDurationFrames, row.checkpointCodec,
    row.checkpointAudioCodec, row.checkpointContainer, row.runtimeCommitSha,
    row.runtimeTreeHash, row.runtimeContractGraphHash, row.runtimeToolchainHash,
    row.runtimeRenderBundleHash, row.runtimeIdentityHash,
    row.checkpointCommittedAt, row.checkpointRecordedAt,
  ]
  if (values.every((value) => value === null)) return undefined
  if (values.some((value) => value === null)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic render checkpoint is partial')
  }
  const hydrated: SyntheticProductionRenderCheckpoint = {
    operationId: row.operationId,
    outputArtifactId: row.outputArtifactId,
    attempt: row.checkpointAttempt!,
    outputKind: row.outputKind as SyntheticProductionRenderCheckpoint['outputKind'],
    renderInputHash: row.renderInputHash,
    outputKey: row.checkpointOutputKey!,
    outputSha256: row.checkpointOutputSha256!,
    byteSize: Number(row.checkpointByteSize!),
    width: row.checkpointWidth!,
    height: row.checkpointHeight!,
    fps: row.checkpointFps!,
    durationInFrames: row.checkpointDurationFrames!,
    codec: row.checkpointCodec as 'h264',
    audioCodec: row.checkpointAudioCodec as 'aac',
    container: row.checkpointContainer as 'mp4',
    runtimeIdentity: {
      commitSha: row.runtimeCommitSha!,
      treeHash: row.runtimeTreeHash!,
      contractGraphHash: row.runtimeContractGraphHash!,
      toolchainHash: row.runtimeToolchainHash!,
      renderBundleHash: row.runtimeRenderBundleHash!,
    },
    runtimeIdentityHash: row.runtimeIdentityHash!,
    committedAt: row.checkpointCommittedAt!.toISOString(),
    recordedAt: row.checkpointRecordedAt!.toISOString(),
  }
  assertSyntheticProductionRenderCheckpoint(hydrated)
  return Object.freeze(hydrated)
}

export class PrismaSyntheticProductionRenderRepository implements SyntheticProductionRenderRepository {
  private readonly client: PrismaClient
  private readonly createEventId: () => string
  private readonly protectedInputs: ProtectedRenderInputStore

  constructor(client: PrismaClient, protectedInputs: ProtectedRenderInputStore, createEventId: () => string = randomUUID) {
    this.client = client
    this.protectedInputs = protectedInputs
    this.createEventId = createEventId
  }

  private async hydrateBinding(
    row: Readonly<V2SyntheticProductionRenderOperation & {
      qualityReport: V2SyntheticProductionRenderQualityReport | null
    }>,
    requireCurrentAuthority: boolean,
  ) {
    const plan = requireCurrentAuthority
      ? await assertCurrentSyntheticRenderAuthority(this.client, row, new Date())
      : await readHistoricalSyntheticRenderPlan(this.client, row)
    const context = assertSyntheticProductionRenderContext(parseRecord(row.contextJson, 'synthetic render context') as never)
    if (
      context.contextHash !== row.contextHash || context.operationId !== row.operationId ||
      context.workspaceId !== row.workspaceId || context.projectId !== row.projectId ||
      context.projectVersionId !== row.projectVersionId || context.projectVersionHash !== row.projectVersionHash ||
      context.productionRunId !== row.productionRunId || context.editPlanSnapshotId !== row.editPlanSnapshotId ||
      context.editPlanSnapshotHash !== row.editPlanSnapshotHash || context.planHash !== row.planHash ||
      context.outputKind !== row.outputKind || context.aspectRatio !== row.aspectRatio ||
      context.renderInputRef !== row.renderInputRef || context.renderInputHash !== row.renderInputHash ||
      context.propsHash !== row.propsHash || context.outputArtifactId !== row.outputArtifactId ||
      context.outputManifestId !== row.outputManifestId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic render context does not match its row')
    const storedCheckpoint = checkpoint(row)
    let qualityReport: Readonly<SyntheticProductionRenderQualityReport> | undefined
    if (row.qualityReport) {
      qualityReport = assertSyntheticProductionRenderQualityReport(
        parseRecord(row.qualityReport.reportJson, 'synthetic render quality report') as unknown as SyntheticProductionRenderQualityReport,
      )
      const spec = await this.protectedInputs.read(row.workspaceId, row.renderInputRef, row.renderInputHash)
      if (!spec) throw new DomainError('PERSISTENCE_CONFLICT', 'Protected RenderInput is missing for synthetic render quality')
      assertQualityBinding(row, row.qualityReport, qualityReport, storedCheckpoint, spec)
    }
    return Object.freeze({
      context,
      plan,
      ...(storedCheckpoint ? { checkpoint: storedCheckpoint } : {}),
      ...(qualityReport ? { qualityReport } : {}),
    })
  }

  async readBinding(input: { workspaceId: string; operationId: string }) {
    const row = await this.client.v2SyntheticProductionRenderOperation.findFirst({
      where: { workspaceId: input.workspaceId, operationId: input.operationId },
      include: { qualityReport: true },
    })
    if (!row) return null
    return this.hydrateBinding(row, true)
  }

  async readLatestByRun(input: { workspaceId: string; projectId: string; runId: string }) {
    const row = await this.client.v2SyntheticProductionRenderOperation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        productionRunId: input.runId,
      },
      orderBy: [{ createdAt: 'desc' }, { operationId: 'desc' }],
      include: {
        qualityReport: true,
        buildAttestation: true,
        operation: { include: OPERATION_INCLUDE },
      },
    })
    if (!row) return null
    const hydratedOperation = hydratePublicOperationRecord(row.operation)
    const operation = hydratedOperation.operation
    if (operation.type !== 'synthetic-production-render' ||
      hydratedOperation.context.kind !== 'synthetic-production-render' ||
      hydratedOperation.context.contextHash !== row.contextHash ||
      hydratedOperation.context.productionRunId !== row.productionRunId ||
      hydratedOperation.context.renderInputHash !== row.renderInputHash ||
      hydratedOperation.context.outputArtifactId !== row.outputArtifactId ||
      hydratedOperation.context.outputManifestId !== row.outputManifestId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render public operation lost its subtype binding')
    }
    const binding = await this.hydrateBinding(row, operation.status !== 'succeeded')
    const attestation = row.buildAttestation ? hydrateAttestation(row.buildAttestation) : undefined
    if (attestation) await assertAttestationBinding(this.client, row, attestation, binding.checkpoint)
    if (operation.status === 'succeeded' && (!binding.qualityReport || !attestation)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Succeeded synthetic render is missing quality or build attestation')
    }
    return Object.freeze({
      ...binding,
      operation,
      ...(attestation ? { attestation } : {}),
    })
  }

  async findReadyToFinalize(input: { now: string }) {
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime()) || now.toISOString() !== input.now) {
      throw new DomainError('INVALID_ARGUMENT', 'Synthetic render finalization clock is invalid')
    }
    const row = await this.client.v2SyntheticProductionRenderOperation.findFirst({
      where: {
        operation: { status: 'waiting', phase: 'waiting' },
        qualityReport: { passed: true },
        buildAttestation: { isNot: null },
      },
      orderBy: [{ updatedAt: 'asc' }, { operationId: 'asc' }],
      select: { workspaceId: true, operationId: true, operation: { select: { attempt: true } } },
    })
    return row ? Object.freeze({
      workspaceId: row.workspaceId,
      operationId: row.operationId,
      attempt: row.operation.attempt,
    }) : null
  }

  async recordCheckpoint(input: Parameters<SyntheticProductionRenderRepository['recordCheckpoint']>[0]): Promise<boolean> {
    const value = assertSyntheticProductionRenderCheckpoint(input.checkpoint)
    if (value.operationId !== input.operationId || value.attempt !== input.attempt) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render checkpoint does not match its lease')
    }
    return this.client.$transaction(async (transaction) => {
      const row = await transaction.v2SyntheticProductionRenderOperation.findFirst({
        where: { operationId: input.operationId },
        include: { operation: true },
      })
      if (!row) return false
      await assertCurrentSyntheticRenderAuthority(transaction, row, new Date(input.now))
      if (
        row.operation.status !== 'running' || row.operation.phase !== 'verifying' ||
        row.operation.leaseOwner !== input.leaseOwner || row.operation.attempt !== input.attempt ||
        row.operation.leaseExpiresAt === null || row.operation.leaseExpiresAt.getTime() <= Date.parse(input.now) ||
        row.outputArtifactId !== value.outputArtifactId || row.outputKind !== value.outputKind ||
        row.renderInputHash !== value.renderInputHash
      ) return false
      const existing = checkpoint(row)
      if (existing) {
        if (stableSerialize(existing) !== stableSerialize(value)) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render checkpoint already exists with different output')
        }
        return true
      }
      const updated = await transaction.v2SyntheticProductionRenderOperation.updateMany({
        where: {
          operationId: input.operationId,
          workspaceId: row.workspaceId,
          checkpointAttempt: null,
          operation: {
            status: 'running', phase: 'verifying', leaseOwner: input.leaseOwner,
            attempt: input.attempt, leaseExpiresAt: { gt: new Date(input.now) },
          },
        },
        data: {
          runtimeCommitSha: value.runtimeIdentity.commitSha,
          runtimeTreeHash: value.runtimeIdentity.treeHash,
          runtimeContractGraphHash: value.runtimeIdentity.contractGraphHash,
          runtimeToolchainHash: value.runtimeIdentity.toolchainHash,
          runtimeRenderBundleHash: value.runtimeIdentity.renderBundleHash,
          runtimeIdentityHash: value.runtimeIdentityHash,
          checkpointAttempt: value.attempt,
          checkpointOutputKey: value.outputKey,
          checkpointOutputSha256: value.outputSha256,
          checkpointByteSize: BigInt(value.byteSize),
          checkpointWidth: value.width,
          checkpointHeight: value.height,
          checkpointFps: value.fps,
          checkpointDurationFrames: value.durationInFrames,
          checkpointCodec: value.codec,
          checkpointAudioCodec: value.audioCodec,
          checkpointContainer: value.container,
          checkpointCommittedAt: new Date(value.committedAt),
          checkpointRecordedAt: new Date(value.recordedAt),
          updatedAt: new Date(input.now),
        },
      })
      return updated.count === 1
    })
  }

  async recordQuality(input: Parameters<SyntheticProductionRenderRepository['recordQuality']>[0]): Promise<boolean> {
    const report = assertSyntheticProductionRenderQualityReport(input.report)
    if (report.publicOperationId !== input.operationId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render quality report belongs to another operation')
    }
    const source = await this.client.v2SyntheticProductionRenderOperation.findUnique({
      where: { operationId: input.operationId },
      select: { workspaceId: true, renderInputRef: true, renderInputHash: true },
    })
    if (!source) return false
    const spec = await this.protectedInputs.read(source.workspaceId, source.renderInputRef, source.renderInputHash)
    if (!spec || stableSerialize(report.expected) !== stableSerialize(qualityExpected(spec))) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render quality expected contract differs from protected RenderInput')
    }
    return this.client.$transaction(async (transaction) => {
      const row = await transaction.v2SyntheticProductionRenderOperation.findFirst({
        where: { operationId: input.operationId },
        include: { operation: true, qualityReport: true },
      })
      if (!row) return false
      if (
        row.operation.status !== 'running' || row.operation.phase !== 'verifying' ||
        row.operation.leaseOwner !== input.leaseOwner || row.operation.attempt !== input.attempt ||
        row.operation.leaseExpiresAt === null || row.operation.leaseExpiresAt.getTime() <= Date.parse(input.now)
      ) return false
      await assertCurrentSyntheticRenderAuthority(transaction, row, new Date(input.now))
      const storedCheckpoint = checkpoint(row)
      if (!storedCheckpoint ||
        report.workspaceId !== row.workspaceId || report.projectId !== row.projectId ||
        report.projectVersionId !== row.projectVersionId || report.productionRunId !== row.productionRunId ||
        report.editPlanSnapshotId !== row.editPlanSnapshotId || report.planHash !== row.planHash ||
        report.renderInputHash !== row.renderInputHash || report.propsHash !== row.propsHash ||
        report.outputKind !== row.outputKind || report.outputArtifactId !== row.outputArtifactId ||
        report.outputManifestId !== row.outputManifestId || report.outputSha256 !== storedCheckpoint.outputSha256 ||
        row.renderInputRef !== source.renderInputRef || row.renderInputHash !== source.renderInputHash ||
        report.byteSize !== storedCheckpoint.byteSize || report.runtimeIdentityHash !== storedCheckpoint.runtimeIdentityHash ||
        report.measured.width !== storedCheckpoint.width || report.measured.height !== storedCheckpoint.height ||
        report.measured.fps !== storedCheckpoint.fps || report.measured.durationInFrames !== storedCheckpoint.durationInFrames ||
        report.measured.codec !== storedCheckpoint.codec || report.measured.audioCodec !== storedCheckpoint.audioCodec ||
        report.measured.container !== storedCheckpoint.container || !report.measured.decodable
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render quality report lost its checkpoint binding')
      const [artifact, manifest] = await Promise.all([
        transaction.v2MediaArtifact.findFirst({
          where: {
            id: row.outputArtifactId,
            workspaceId: row.workspaceId,
            status: 'available',
            sha256: report.outputSha256,
            byteSize: BigInt(report.byteSize),
            mediaType: 'video',
            container: 'mp4',
          },
          select: { id: true },
        }),
        transaction.v2MediaArtifactManifest.findFirst({
          where: { id: row.outputManifestId, workspaceId: row.workspaceId, artifactId: row.outputArtifactId },
          select: { id: true },
        }),
      ])
      if (!artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render output artifact or manifest is unavailable')
      if (row.qualityReport) {
        assertQualityBinding(row, row.qualityReport, report, storedCheckpoint, spec)
        return true
      }
      await transaction.v2SyntheticProductionRenderQualityReport.create({
        data: {
          id: report.id,
          workspaceId: report.workspaceId,
          projectId: report.projectId,
          projectVersionId: report.projectVersionId,
          productionRunId: report.productionRunId,
          operationId: report.publicOperationId,
          outputArtifactId: report.outputArtifactId,
          outputManifestId: report.outputManifestId,
          schemaVersion: report.schemaVersion,
          reportJson: stableSerialize(report),
          reportHash: report.reportHash,
          passed: report.passed,
          evaluatedAt: new Date(report.evaluatedAt),
        },
      })
      return true
    })
  }

  async finalizeAttested(input: Parameters<SyntheticProductionRenderRepository['finalizeAttested']>[0]): Promise<boolean> {
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime()) || now.toISOString() !== input.now) {
      throw new DomainError('INVALID_ARGUMENT', 'Synthetic render finalization clock is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const row = await transaction.v2SyntheticProductionRenderOperation.findFirst({
        where: { operationId: input.operationId },
        include: { qualityReport: true, buildAttestation: true },
      })
      if (!row) return false
      const operationRow = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      if (!operationRow || operationRow.status !== 'running' || operationRow.phase !== 'persisting' ||
        operationRow.leaseOwner !== input.leaseOwner || operationRow.attempt !== input.attempt ||
        operationRow.leaseExpiresAt === null || operationRow.leaseExpiresAt.getTime() <= now.getTime()) return false
      const plan = await assertCurrentSyntheticRenderAuthority(transaction, row, now)
      const storedCheckpoint = checkpoint(row)
      if (!storedCheckpoint || !row.qualityReport?.passed || !row.buildAttestation) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render cannot complete without checkpoint, quality and attestation')
      }
      const quality = assertSyntheticProductionRenderQualityReport(
        parseRecord(row.qualityReport.reportJson, 'synthetic render quality report') as unknown as SyntheticProductionRenderQualityReport,
      )
      const attestation = hydrateAttestation(row.buildAttestation)
      const spec = await this.protectedInputs.read(row.workspaceId, row.renderInputRef, row.renderInputHash)
      if (!spec) throw new DomainError('PERSISTENCE_CONFLICT', 'Protected RenderInput is missing before synthetic render completion')
      assertQualityBinding(row, row.qualityReport, quality, storedCheckpoint, spec)
      const manifest = await transaction.v2MediaArtifactManifest.findFirst({
        where: {
          id: row.outputManifestId,
          workspaceId: row.workspaceId,
          artifactId: row.outputArtifactId,
          artifact: {
            status: 'available',
            sha256: storedCheckpoint.outputSha256,
            byteSize: BigInt(storedCheckpoint.byteSize),
            mediaType: 'video',
            container: 'mp4',
          },
        },
        select: { manifestHash: true },
      })
      if (!manifest ||
        quality.publicOperationId !== row.operationId || quality.productionRunId !== row.productionRunId ||
        quality.projectVersionId !== row.projectVersionId || quality.editPlanSnapshotId !== row.editPlanSnapshotId ||
        quality.planHash !== plan.planHash || quality.renderInputHash !== row.renderInputHash ||
        quality.outputArtifactId !== row.outputArtifactId || quality.outputManifestId !== row.outputManifestId ||
        quality.runtimeIdentityHash !== storedCheckpoint.runtimeIdentityHash ||
        attestation.workspaceId !== row.workspaceId || attestation.projectId !== row.projectId ||
        attestation.projectVersionId !== row.projectVersionId || attestation.projectVersionHash !== row.projectVersionHash ||
        attestation.productionRunId !== row.productionRunId || attestation.publicOperationId !== row.operationId ||
        attestation.planSnapshotId !== row.editPlanSnapshotId || attestation.planSnapshotHash !== row.editPlanSnapshotHash ||
        attestation.renderManifestId !== row.outputManifestId || attestation.renderManifestHash !== manifest.manifestHash ||
        calculateSyntheticBuildIdentityHash(attestation.identity) !== storedCheckpoint.runtimeIdentityHash ||
        stableSerialize(attestation.identity) !== stableSerialize(storedCheckpoint.runtimeIdentity)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render terminal bindings do not match')
      }
      const current = hydratePublicOperationRecord(operationRow).operation
      const succeeded = succeedPublicOperation(current, input.now)
      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          status: 'running',
          phase: 'persisting',
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
          updatedAt: operationRow.updatedAt,
        },
        data: {
          status: succeeded.status,
          phase: succeeded.phase,
          progressCompleted: succeeded.progress?.completed,
          progressTotal: succeeded.progress?.total,
          progressUnit: succeeded.progress?.unit,
          cancelable: succeeded.cancelable,
          retryable: succeeded.retryable,
          resultJson: succeeded.result ? JSON.stringify(succeeded.result) : null,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          completedAt: succeeded.completedAt ? new Date(succeeded.completedAt) : null,
          nextAttemptAt: null,
          deadLetteredAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: now,
        },
      })
      if (updated.count !== 1) return false
      const unfinished = await transaction.v2SyntheticProductionRenderOperation.count({
        where: {
          workspaceId: row.workspaceId,
          productionRunId: row.productionRunId,
          operationId: { not: row.operationId },
          operation: { status: { in: ['queued', 'running', 'retrying', 'waiting'] } },
        },
      })
      if (unfinished === 0) {
        const runUpdated = await transaction.v2SyntheticProductionRun.updateMany({
          where: {
            id: row.productionRunId,
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            status: 'rendering',
          },
          data: { status: 'completed' },
        })
        if (runUpdated.count !== 1) {
          throw new DomainError('VERSION_CONFLICT', 'Synthetic production run changed before render completion')
        }
      }
      await persistOperationStatusEvents(transaction, current.status, succeeded, this.createEventId)
      return true
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}
