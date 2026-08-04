import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import {
  createSpeakerDiarizationRun,
  type SpeakerDiarizationRun,
  type SpeakerDiarizationSegment,
} from '../domain/speaker-diarization.ts'
import type {
  PersistedSpeakerDiarizationRun,
  SpeakerDiarizationRepository,
} from './ports/speaker-diarization-repository.ts'
import {
  createProjectAnalysisExecutionContext,
} from './project-analysis-execution.ts'
import type {
  ProjectAnalysisExecutionProvenance,
} from './ports/long-form-stage-persistence.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value.trim())) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return value
}

export function calculateSpeakerDiarizationRequestFingerprint(input: {
  workspaceId: string
  projectId: string
  workflowId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  durationMs: number
  providerInput: SpeakerDiarizationRun['providerInput']
  expectedStageInputHash: string
  provider: SpeakerDiarizationRun['provider']
  segments: readonly Readonly<Pick<
    SpeakerDiarizationSegment,
    | 'providerSegmentId'
    | 'providerLabel'
    | 'startMs'
    | 'endMs'
    | 'text'
  >>[]
  usageSeconds: number
  costMinorUnits: number
  elapsedMs: number
  createdByClientId: string
  actorContextHash: string
  provenance: Readonly<ProjectAnalysisExecutionProvenance>
}): string {
  return calculateCanonicalHash({
    schemaVersion: 'persist-speaker-diarization-request/v2',
    ...input,
  })
}

export function persistSpeakerDiarizationService(dependencies: {
  repository: SpeakerDiarizationRepository
  createRunId: () => string
  clock: () => Date
}) {
  return async function persist(request: {
    workspaceId: string
    projectId: string
    workflowId: string
    expectedStageInputHash: string
    provider: Readonly<{
      id: string
      model: string
      version: string
    }>
    providerInput: Readonly<{
      sha256: string
      byteSize: number
      durationMs: number
      preparation: Readonly<{
        toolId: string
        toolVersion: string
        configurationHash: string
      }>
    }>
    segments: readonly Readonly<{
      providerSegmentId: string
      providerLabel: string
      startMs: number
      endMs: number
      text: string
    }>[]
    usageSeconds: number
    costMinorUnits: number
    elapsedMs: number
    lease: Readonly<{
      operationId: string
      owner: string
      attempt: number
    }>
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const workflowId = identity(request.workflowId, 'workflowId')
    const expectedStageInputHash = hash(
      request.expectedStageInputHash,
      'expectedStageInputHash',
    )
    const context = await dependencies.repository.readSourceContext({
      workspaceId,
      projectId,
      workflowId,
    })
    if (!context) {
      throw new DomainError(
        'LONG_FORM_INDEX_WORKFLOW_NOT_FOUND',
        'Long-form workflow diarization source was not found',
      )
    }
    if (
      context.operationId !== request.lease.operationId ||
      context.stageStatus !== 'running' ||
      context.stageInputHash !== expectedStageInputHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Diarization source changed before persistence',
      )
    }
    const execution = createProjectAnalysisExecutionContext({
      workspaceId,
      authenticationAudit: context.authenticationAudit,
      provenance: Object.freeze({
        kind: 'long-form-stage' as const,
        workflowId,
        operationId: context.operationId,
        stage: 'diarization' as const,
        stageInputHash: context.stageInputHash,
        stageIdempotencyKey: context.stageIdempotencyKey,
      }),
      expectedStage: 'diarization',
    })
    const requestFingerprint =
      calculateSpeakerDiarizationRequestFingerprint({
        workspaceId,
        projectId,
        workflowId,
        sourceArtifactId: context.sourceArtifactId,
        sourceArtifactSha256: context.sourceArtifactSha256,
        sourceManifestId: context.sourceManifestId,
        sourceManifestHash: context.sourceManifestHash,
        sourceTranscriptId: context.sourceTranscriptId,
        sourceTranscriptHash: context.sourceTranscriptHash,
        durationMs: context.durationMs,
        providerInput: request.providerInput,
        expectedStageInputHash,
        provider: request.provider,
        segments: request.segments,
        usageSeconds: request.usageSeconds,
        costMinorUnits: request.costMinorUnits,
        elapsedMs: request.elapsedMs,
        createdByClientId: context.createdByClientId,
        actorContextHash: execution.authenticationAudit.contextHash,
        provenance: execution.provenance,
      })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      workflowId,
      actorContextHash: execution.authenticationAudit.contextHash,
      idempotencyKey: context.stageIdempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Diarization stage key was used with a different result',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const createdAt = dependencies.clock().toISOString()
    const run = Object.freeze({
      ...createSpeakerDiarizationRun({
        id: identity(dependencies.createRunId(), 'created run ID'),
        workspaceId,
        projectId,
        workflowId,
        sourceArtifactId: context.sourceArtifactId,
        sourceArtifactSha256: context.sourceArtifactSha256,
        sourceManifestId: context.sourceManifestId,
        sourceManifestHash: context.sourceManifestHash,
        sourceTranscriptId: context.sourceTranscriptId,
        sourceTranscriptHash: context.sourceTranscriptHash,
        durationMs: context.durationMs,
        providerInput: request.providerInput,
        provider: request.provider,
        segments: request.segments,
        usageSeconds: request.usageSeconds,
        costMinorUnits: request.costMinorUnits,
        elapsedMs: request.elapsedMs,
        requestFingerprint,
        idempotencyKey: context.stageIdempotencyKey,
        createdByClientId: context.createdByClientId,
        createdAt,
      }),
      authenticationAudit: execution.authenticationAudit,
      provenance: execution.provenance,
    }) as Readonly<PersistedSpeakerDiarizationRun>
    const persisted = await dependencies.repository.persistWithLease({
      run,
      operationId: identity(
        request.lease.operationId,
        'lease.operationId',
      ),
      leaseOwner: identity(request.lease.owner, 'lease.owner'),
      operationAttempt: request.lease.attempt,
      expectedStageInputHash,
      now: createdAt,
    })
    if (!persisted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Diarization lease was lost before persistence',
      )
    }
    return persisted
  }
}

export function readSpeakerDiarizationService(dependencies: {
  repository: SpeakerDiarizationRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const run = await dependencies.repository.findRun({
      workspaceId: identity(input.workspaceId, 'workspaceId'),
      projectId: identity(input.projectId, 'projectId'),
      runId: identity(input.runId, 'runId'),
    })
    if (!run) {
      throw new DomainError(
        'SPEAKER_DIARIZATION_NOT_FOUND',
        'Speaker diarization run was not found',
      )
    }
    return run
  }
}
