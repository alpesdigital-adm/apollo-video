import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import { isCurrentSyntheticCriticApproval } from '../../application/synthetic-critic.ts'
import type {
  SyntheticCatalogueEvidence,
  SyntheticCrossProjectReuseEvidence,
  SyntheticPhaseGateEvidenceReader,
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
import { resolveSyntheticCriticThresholds } from '../../domain/synthetic-critic-thresholds.ts'
import { assertSyntheticPresenterPolicy } from '../../domain/synthetic-presenter-policy-engine.ts'
import { PrismaProviderExecutionProvenanceRepository } from './provider-execution-provenance-repository.ts'
import { PrismaProviderJobRepository } from './provider-job-repository.ts'
import { PrismaProviderResultArtifactRepository } from './provider-result-artifact-repository.ts'
import { PrismaSyntheticAudioMasterRepository } from './synthetic-audio-master-repository.ts'
import { PrismaSyntheticCriticReportRepository } from './synthetic-critic-report-repository.ts'
import { PrismaSyntheticMasterAssetRepository } from './synthetic-master-asset-repository.ts'
import { PrismaSyntheticProductionRepository } from './synthetic-production-repository.ts'
import { PrismaSyntheticSpeechSegmentRepository } from './synthetic-speech-segment-repository.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

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
      runtimeClass: receipt.runtimeClass,
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
      report.audioArtifactId !== finalAudio.artifactId ||
      report.alignmentArtifactId !== alignment.artifactId
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

    // The current cache and transformation ledgers do not bind an actual
    // consuming synthetic render. W24.3 adds that lineage; until then these
    // checks remain missing rather than being inferred from time windows.
    const reuses: SyntheticCrossProjectReuseEvidence[] = []
    const transformations: SyntheticTransformationEvidence[] = []

    // W24.3 will persist a synthetic render subtype and its manifest/runtime
    // binding. Until that server-owned chain exists, no build attestation can
    // be joined to a render and F3-GATE-004 must remain missing.
    const swaps: SyntheticProviderSwapEvidence[] = []

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
