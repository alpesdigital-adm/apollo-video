import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ClaimedPublicOperationRecord,
  PublicOperationLeaseCommand,
  PublicOperationListQuery,
  PublicOperationPersistenceResult,
  PublicOperationRecord,
  PublicOperationRepository,
  PublicOperationCreationContext,
  ResumeWaitingPublicOperationCommand,
} from '../../application/ports/public-operation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandImpact } from '../../domain/command-impact.ts'
import type { RenderColorPipelineBinding } from '../../application/resolve-render-color-pipelines.ts'
import {
  advancePublicOperationPhase,
  assertPublicOperation,
  cancelPublicOperation,
  isTerminalPublicOperation,
  rehydratePublicOperation,
  retryPublicOperation,
  retryOrFailPublicOperation,
  resumeWaitingPublicOperation,
  requiresArtifactRenderCheckpoint,
  startPublicOperationAttempt,
  succeedPublicOperation,
  waitPublicOperation,
  type PublicOperation,
  type PublicOperationError,
  type PublicOperationResult,
  type PublicOperationRunningPhase,
} from '../../domain/public-operation.ts'
import {
  projectStatusTransitionPath,
  projectStatusTransitionSources,
} from '../../domain/project.ts'

type StoredOperation = Prisma.V2PublicOperationGetPayload<{
  include: {
    artifactRender: {
      include: {
        manifest: { select: { artifactId: true } }
        artifact: { select: { sha256: true; byteSize: true; container: true } }
        authorization: {
          select: {
            artifactId: true
            manifestId: true
            inputHash: true
            clientId: true
            status: true
          }
        }
      }
    }
    mediaIngest: true
    projectProxyRender: true
    projectFinalExport: true
    sourceCleanupPlan: true
    longFormIndexWorkflow: true
  }
}>

const OPERATION_INCLUDE = {
  artifactRender: {
    include: {
      manifest: { select: { artifactId: true } },
      artifact: { select: { sha256: true, byteSize: true, container: true } },
      authorization: {
        select: {
          artifactId: true,
          manifestId: true,
          inputHash: true,
          clientId: true,
          status: true,
        },
      },
    },
  },
  mediaIngest: true,
  projectProxyRender: true,
  projectFinalExport: true,
  sourceCleanupPlan: true,
  longFormIndexWorkflow: true,
} as const

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function validColorPipelineBindings(value: unknown): value is readonly RenderColorPipelineBinding[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 128 &&
    new Set(value.map((item) => item?.sourceArtifactId)).size === value.length &&
    value.every((item) => item && typeof item === 'object' &&
      Object.keys(item).sort().join(',') === 'compilationHash,compilationId,pipelineHash,sourceArtifactId,sourceManifestId' &&
      ID_PATTERN.test(item.sourceArtifactId) && ID_PATTERN.test(item.sourceManifestId) &&
      ID_PATTERN.test(item.compilationId) && SHA256_PATTERN.test(item.compilationHash) &&
      SHA256_PATTERN.test(item.pipelineHash))
}

function parseColorPipelineBindings(value: string): readonly Readonly<RenderColorPipelineBinding>[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!validColorPipelineBindings(parsed) || stableSerialize(parsed) !== value) throw new Error('invalid')
    return Object.freeze((parsed as RenderColorPipelineBinding[]).map((item) => Object.freeze(item)))
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render color pipeline bindings are invalid')
  }
}

function parseStoredCommandImpact(value: string) {
  try {
    const payload = JSON.parse(value) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('impact' in payload)) {
      throw new Error('invalid')
    }
    return parseCommandImpact((payload as { impact: unknown }).impact)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy reuse Command impact is invalid')
  }
}
const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,510}\.mp4$/

function checkpointFields(detail: StoredOperation['artifactRender']) {
  if (!detail) return []
  return [
    detail.outputKey,
    detail.outputSha256,
    detail.outputByteSize,
    detail.outputWidth,
    detail.outputHeight,
    detail.outputFps,
    detail.outputDurationInFrames,
    detail.outputCodec,
    detail.outputContainer,
    detail.outputAttempt,
    detail.outputCommittedAt,
    detail.outputRecordedAt,
  ]
}

function hasCompleteCheckpoint(detail: NonNullable<StoredOperation['artifactRender']>): boolean {
  return checkpointFields(detail).every((value) => value !== null)
}

function parseCommandDate(value: string, field: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', `${field} must be a valid date`)
  }
  return date
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function parseResult(value: string | null): PublicOperationResult | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => key !== 'resource') ||
      !('resource' in parsed) ||
      typeof parsed.resource !== 'object' ||
      parsed.resource === null ||
      Array.isArray(parsed.resource)
    ) {
      throw new Error('invalid result')
    }
    const resource = parsed.resource as Record<string, unknown>
    if (
      Object.keys(resource).some((key) => !['type', 'id', 'manifestId'].includes(key)) ||
      resource.type !== 'media-artifact' ||
      typeof resource.id !== 'string' ||
      typeof resource.manifestId !== 'string'
    ) {
      throw new Error('invalid result resource')
    }
    return {
      resource: {
        type: 'media-artifact',
        id: resource.id,
        manifestId: resource.manifestId,
      },
    }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation result is invalid')
  }
}

function hydrateRecord(row: StoredOperation): PublicOperationRecord {
  const renderDetail = row.artifactRender
  const ingestDetail = row.mediaIngest
  const projectRenderDetail = row.projectProxyRender
  const finalExportDetail = row.projectFinalExport
  const sourceCleanupDetail = row.sourceCleanupPlan
  const longFormDetail = row.longFormIndexWorkflow
  const isRender = row.type === 'artifact-render'
  const isIngest = row.type === 'media-ingest'
  const isProjectRender = row.type === 'project-proxy-render'
  const isFinalExport = row.type === 'project-final-export'
  const isSourceCleanup = row.type === 'source-cleanup'
  const isLongFormIndex = row.type === 'long-form-index'
  const projectColorBindings = projectRenderDetail
    ? parseColorPipelineBindings(projectRenderDetail.colorPipelineBindingsJson)
    : undefined
  const projectReuseFields = projectRenderDetail ? [
    projectRenderDetail.reusedFromOperationId,
    projectRenderDetail.reuseCommandId,
    projectRenderDetail.reuseImpactHash,
    projectRenderDetail.reuseBaseVersionId,
  ] : []
  const isProjectReuse = projectReuseFields.length > 0 && projectReuseFields.every((value) => value !== null)
  const hasPartialProjectReuse = projectReuseFields.some((value) => value !== null) && !isProjectReuse
  const finalColorBindings = finalExportDetail
    ? parseColorPipelineBindings(finalExportDetail.colorPipelineBindingsJson)
    : undefined
  if (
    row.targetType !== 'media-artifact' ||
    [
      isRender,
      isIngest,
      isProjectRender,
      isFinalExport,
      isSourceCleanup,
      isLongFormIndex,
    ].filter(Boolean).length !== 1
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored PublicOperation context is invalid',
      { operationId: row.id },
    )
  }
  if (isRender && (
    !renderDetail || ingestDetail || projectRenderDetail || finalExportDetail || sourceCleanupDetail || longFormDetail || row.targetId !== renderDetail.artifactId ||
    row.projectId !== null ||
    row.workspaceId !== renderDetail.workspaceId ||
    renderDetail.manifest.artifactId !== renderDetail.artifactId ||
    renderDetail.authorization.artifactId !== renderDetail.artifactId ||
    renderDetail.authorization.manifestId !== renderDetail.manifestId ||
    renderDetail.authorization.inputHash !== renderDetail.inputHash ||
    renderDetail.authorization.clientId !== row.clientId ||
    renderDetail.authorization.status !== 'authorized' ||
    !SHA256_PATTERN.test(renderDetail.inputHash)
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render operation context is invalid', { operationId: row.id })
  }
  if (isIngest && (
    !ingestDetail || renderDetail || projectRenderDetail || finalExportDetail || sourceCleanupDetail || longFormDetail || row.targetId !== ingestDetail.sourceArtifactId ||
    row.projectId !== ingestDetail.projectId ||
    row.workspaceId !== ingestDetail.workspaceId ||
    !ID_PATTERN.test(ingestDetail.projectId) || !ID_PATTERN.test(ingestDetail.sourceManifestId) ||
    ingestDetail.originalFileName.trim().length < 1
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored ingest operation context is invalid', { operationId: row.id })
  }
  if (isProjectRender && (
    !projectRenderDetail || renderDetail || ingestDetail || finalExportDetail || sourceCleanupDetail || longFormDetail ||
    row.targetId !== projectRenderDetail.outputArtifactId ||
    row.projectId !== projectRenderDetail.projectId ||
    row.workspaceId !== projectRenderDetail.workspaceId ||
    ![projectRenderDetail.projectId, projectRenderDetail.projectVersionId, projectRenderDetail.editPlanSnapshotId,
      projectRenderDetail.sourceArtifactId, projectRenderDetail.sourceManifestId, projectRenderDetail.outputArtifactId,
      projectRenderDetail.outputManifestId].every((value) => ID_PATTERN.test(value)) ||
    !SHA256_PATTERN.test(projectRenderDetail.inputHash) || hasPartialProjectReuse ||
    (isProjectReuse && (
      row.status !== 'succeeded' || row.phase !== 'completed' ||
      !ID_PATTERN.test(projectRenderDetail.reusedFromOperationId as string) ||
      !ID_PATTERN.test(projectRenderDetail.reuseCommandId as string) ||
      !ID_PATTERN.test(projectRenderDetail.reuseBaseVersionId as string) ||
      !SHA256_PATTERN.test(projectRenderDetail.reuseImpactHash as string)
    )) ||
    projectRenderDetail.originalFileName.trim().length < 1
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy render context is invalid', { operationId: row.id })
  }
  if (isFinalExport && (
    !finalExportDetail || renderDetail || ingestDetail || projectRenderDetail || sourceCleanupDetail || longFormDetail ||
    row.targetId !== finalExportDetail.outputArtifactId ||
    row.projectId !== finalExportDetail.projectId ||
    row.workspaceId !== finalExportDetail.workspaceId ||
    ![finalExportDetail.projectId, finalExportDetail.projectVersionId, finalExportDetail.editPlanSnapshotId,
      finalExportDetail.directorRunId, finalExportDetail.qualitySnapshotId,
      finalExportDetail.proxyReviewId, finalExportDetail.proxyArtifactId, finalExportDetail.sourceArtifactId,
      finalExportDetail.sourceManifestId, finalExportDetail.outputArtifactId,
      finalExportDetail.outputManifestId, finalExportDetail.approvedById].every((value) => ID_PATTERN.test(value)) ||
    ![finalExportDetail.projectVersionHash, finalExportDetail.qualitySnapshotHash,
      finalExportDetail.proxyReviewHash, finalExportDetail.inputHash].every((value) => SHA256_PATTERN.test(value)) ||
    !['9:16', '16:9', '4:5', '1:1', '21:9'].includes(finalExportDetail.outputAspectRatio) ||
    ![finalExportDetail.outputWidth, finalExportDetail.outputHeight, finalExportDetail.outputFps].every((value) => Number.isSafeInteger(value) && value > 0) ||
    finalExportDetail.outputWidth % 2 !== 0 || finalExportDetail.outputHeight % 2 !== 0 ||
    finalExportDetail.outputCodec !== 'h264' ||
    finalExportDetail.outputAudioCodec !== 'aac' ||
    finalExportDetail.outputContainer !== 'mp4' ||
    finalExportDetail.outputQuality !== 'final' ||
    !['api-client', 'user'].includes(finalExportDetail.approvedByType) ||
    finalExportDetail.originalFileName.trim().length < 1
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project final export context is invalid', { operationId: row.id })
  }
  if (isSourceCleanup && (
    !sourceCleanupDetail || renderDetail || ingestDetail ||
    projectRenderDetail || finalExportDetail || longFormDetail ||
    row.targetId !== sourceCleanupDetail.outputArtifactId ||
    row.projectId !== sourceCleanupDetail.projectId ||
    row.workspaceId !== sourceCleanupDetail.workspaceId ||
    row.clientId !== sourceCleanupDetail.createdByClientId ||
    sourceCleanupDetail.operationId !== row.id ||
    sourceCleanupDetail.decision !== 'execute' ||
    sourceCleanupDetail.postCleanupReviewRequired !== true ||
    ![
      sourceCleanupDetail.projectId,
      sourceCleanupDetail.id,
      sourceCleanupDetail.sourceArtifactId,
      sourceCleanupDetail.sourceManifestId,
      sourceCleanupDetail.outputArtifactId,
      sourceCleanupDetail.outputManifestId,
    ].every((value) =>
      typeof value === 'string' && ID_PATTERN.test(value)) ||
    ![
      sourceCleanupDetail.planHash,
      sourceCleanupDetail.sourceArtifactSha256,
    ].every((value) => SHA256_PATTERN.test(value)) ||
    !['trim', 'crop-reframe', 'cover'].includes(
      sourceCleanupDetail.selectedStrategy,
    )
  )) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source cleanup operation context is invalid',
      { operationId: row.id },
    )
  }
  if (isLongFormIndex && (
    !longFormDetail || renderDetail || ingestDetail ||
    projectRenderDetail || finalExportDetail ||
    sourceCleanupDetail ||
    row.targetId !== longFormDetail.sourceArtifactId ||
    row.projectId !== longFormDetail.projectId ||
    row.workspaceId !== longFormDetail.workspaceId ||
    row.clientId !== longFormDetail.createdByClientId ||
    longFormDetail.operationId !== row.id ||
    ![
      longFormDetail.id,
      longFormDetail.projectId,
      longFormDetail.sourceArtifactId,
      longFormDetail.sourceManifestId,
    ].every((value) => ID_PATTERN.test(value)) ||
    ![
      longFormDetail.sourceArtifactSha256,
      longFormDetail.sourceManifestHash,
      longFormDetail.runHash,
    ].every((value) => SHA256_PATTERN.test(value)) ||
    (
      (longFormDetail.sourceTranscriptId === null) !==
      (longFormDetail.sourceTranscriptHash === null)
    ) ||
    (
      longFormDetail.sourceTranscriptId !== null &&
      (
        !ID_PATTERN.test(longFormDetail.sourceTranscriptId) ||
        !SHA256_PATTERN.test(
          longFormDetail.sourceTranscriptHash as string,
        )
      )
    )
  )) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored long-form index operation context is invalid',
      { operationId: row.id },
    )
  }
  const outputFields = checkpointFields(renderDetail)
  const hasAnyCheckpoint = outputFields.some((value) => value !== null)
  if (
    hasAnyCheckpoint &&
    (!renderDetail || !hasCompleteCheckpoint(renderDetail) ||
      !OUTPUT_KEY_PATTERN.test(renderDetail.outputKey as string) ||
      (renderDetail.outputKey as string).length > 512 ||
      (renderDetail.outputKey as string).includes('//') ||
      !SHA256_PATTERN.test(renderDetail.outputSha256 as string) ||
      (renderDetail.outputByteSize as bigint) <= BigInt(0) ||
      (renderDetail.outputWidth as number) <= 0 ||
      (renderDetail.outputHeight as number) <= 0 ||
      (renderDetail.outputFps as number) <= 0 ||
      (renderDetail.outputDurationInFrames as number) <= 0 ||
      renderDetail.outputCodec !== 'h264' ||
      renderDetail.outputContainer !== 'mp4' ||
      (renderDetail.outputAttempt as number) <= 0 ||
      (renderDetail.outputRecordedAt as Date).getTime() <
        (renderDetail.outputCommittedAt as Date).getTime() ||
      renderDetail.outputSha256 !== renderDetail.artifact.sha256 ||
      renderDetail.outputByteSize !== renderDetail.artifact.byteSize ||
      renderDetail.outputContainer !== renderDetail.artifact.container)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render checkpoint is invalid')
  }
  const hasCompleteLease =
    row.leaseOwner !== null && row.leaseExpiresAt !== null && row.heartbeatAt !== null
  if (
    (row.status === 'running' &&
      (!hasCompleteLease ||
        !ID_PATTERN.test(row.leaseOwner as string) ||
        (row.leaseExpiresAt as Date).getTime() <= (row.heartbeatAt as Date).getTime())) ||
    (row.status !== 'running' &&
      (row.leaseOwner !== null || row.leaseExpiresAt !== null || row.heartbeatAt !== null))
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation lease is invalid')
  }
  const progressFields = [row.progressCompleted, row.progressTotal, row.progressUnit]
  const hasProgress = progressFields.some((value) => value !== null)
  if (hasProgress && row.progressCompleted === null) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation progress is invalid')
  }
  const hasAnyError =
    row.errorCode !== null || row.errorMessage !== null || row.errorRetryable !== null
  if (
    hasAnyError &&
    (row.errorCode === null || row.errorMessage === null || row.errorRetryable === null)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation error is invalid')
  }
  if (
    (row.status === 'retrying' &&
      (row.nextAttemptAt === null ||
        row.nextAttemptAt.getTime() <= row.updatedAt.getTime() ||
        row.deadLetteredAt !== null)) ||
    (row.status === 'failed' &&
      (row.nextAttemptAt !== null ||
        (row.deadLetteredAt !== null &&
          (row.completedAt === null ||
            row.deadLetteredAt.getTime() !== row.completedAt.getTime())))) ||
    (!['retrying', 'failed'].includes(row.status) &&
      (row.nextAttemptAt !== null || row.deadLetteredAt !== null))
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation retry schedule is invalid')
  }

  try {
    const operation = rehydratePublicOperation({
      schemaVersion: 'public-operation/v1',
      id: row.id,
      workspaceId: row.workspaceId,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      clientId: row.clientId,
      type: row.type as PublicOperation['type'],
      status: row.status as PublicOperation['status'],
      phase: row.phase as PublicOperation['phase'],
      ...(hasProgress
        ? {
            progress: {
              completed: row.progressCompleted as number,
              ...(row.progressTotal !== null ? { total: row.progressTotal } : {}),
              ...(row.progressUnit !== null ? { unit: row.progressUnit } : {}),
            },
          }
        : {}),
      cancelable: row.cancelable,
      retryable: row.retryable,
      target: {
        type: 'media-artifact',
        id: isRender
          ? renderDetail!.artifactId
          : isIngest
            ? ingestDetail!.sourceArtifactId
            : isProjectRender
              ? projectRenderDetail!.outputArtifactId
              : isFinalExport
                ? finalExportDetail!.outputArtifactId
                : isSourceCleanup
                  ? sourceCleanupDetail!.outputArtifactId!
                  : longFormDetail!.sourceArtifactId,
        manifestId: isRender
          ? renderDetail!.manifestId
          : isIngest
            ? ingestDetail!.sourceManifestId
            : isProjectRender
              ? projectRenderDetail!.outputManifestId
              : isFinalExport
                ? finalExportDetail!.outputManifestId
                : isSourceCleanup
                  ? sourceCleanupDetail!.outputManifestId!
                  : longFormDetail!.sourceManifestId,
      },
      ...(row.resultJson !== null ? { result: parseResult(row.resultJson) } : {}),
      ...(hasAnyError
        ? {
            error: {
              code: row.errorCode as string,
              message: row.errorMessage as string,
              retryable: row.errorRetryable as boolean,
            },
          }
        : {}),
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt.toISOString() } : {}),
      ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt.toISOString() } : {}),
    })
    return Object.freeze({
      operation,
      ...(row.traceId ? { traceId: row.traceId } : {}),
      context: Object.freeze(isRender ? {
        kind: 'artifact-render' as const,
        authorizationId: renderDetail!.authorizationId,
        inputHash: renderDetail!.inputHash,
      } : isIngest ? {
        kind: 'media-ingest' as const,
        uploadId: ingestDetail!.uploadId,
        projectId: ingestDetail!.projectId,
        originalFileName: ingestDetail!.originalFileName,
        sourceArtifactId: ingestDetail!.sourceArtifactId,
        sourceManifestId: ingestDetail!.sourceManifestId,
      } : isProjectRender && isProjectReuse ? {
        kind: 'project-proxy-reuse' as const,
        projectId: projectRenderDetail!.projectId,
        projectVersionId: projectRenderDetail!.projectVersionId,
        editPlanSnapshotId: projectRenderDetail!.editPlanSnapshotId,
        commandId: projectRenderDetail!.reuseCommandId!,
        impactHash: projectRenderDetail!.reuseImpactHash!,
        baseVersionId: projectRenderDetail!.reuseBaseVersionId!,
        reusedFromOperationId: projectRenderDetail!.reusedFromOperationId!,
        sourceArtifactId: projectRenderDetail!.sourceArtifactId,
        sourceManifestId: projectRenderDetail!.sourceManifestId,
        inputHash: projectRenderDetail!.inputHash,
        outputArtifactId: projectRenderDetail!.outputArtifactId,
        outputManifestId: projectRenderDetail!.outputManifestId,
        originalFileName: projectRenderDetail!.originalFileName,
      } : isProjectRender ? {
        kind: 'project-proxy-render' as const,
        projectId: projectRenderDetail!.projectId,
        projectVersionId: projectRenderDetail!.projectVersionId,
        editPlanSnapshotId: projectRenderDetail!.editPlanSnapshotId,
        sourceArtifactId: projectRenderDetail!.sourceArtifactId,
        sourceManifestId: projectRenderDetail!.sourceManifestId,
        colorPipelineBindings: projectColorBindings!,
        inputHash: projectRenderDetail!.inputHash,
        outputArtifactId: projectRenderDetail!.outputArtifactId,
        outputManifestId: projectRenderDetail!.outputManifestId,
        originalFileName: projectRenderDetail!.originalFileName,
      } : isFinalExport ? {
        kind: 'project-final-export' as const,
        projectId: finalExportDetail!.projectId,
        projectVersionId: finalExportDetail!.projectVersionId,
        projectVersionHash: finalExportDetail!.projectVersionHash,
        editPlanSnapshotId: finalExportDetail!.editPlanSnapshotId,
        directorRunId: finalExportDetail!.directorRunId,
        qualitySnapshotId: finalExportDetail!.qualitySnapshotId,
        qualitySnapshotHash: finalExportDetail!.qualitySnapshotHash,
        proxyReviewId: finalExportDetail!.proxyReviewId,
        proxyReviewHash: finalExportDetail!.proxyReviewHash,
        proxyArtifactId: finalExportDetail!.proxyArtifactId,
        sourceArtifactId: finalExportDetail!.sourceArtifactId,
        sourceManifestId: finalExportDetail!.sourceManifestId,
        colorPipelineBindings: finalColorBindings!,
        inputHash: finalExportDetail!.inputHash,
        outputArtifactId: finalExportDetail!.outputArtifactId,
        outputManifestId: finalExportDetail!.outputManifestId,
        outputSpec: {
          aspectRatio: finalExportDetail!.outputAspectRatio as '9:16' | '16:9' | '4:5' | '1:1' | '21:9',
          width: finalExportDetail!.outputWidth,
          height: finalExportDetail!.outputHeight,
          fps: finalExportDetail!.outputFps,
          codec: finalExportDetail!.outputCodec as 'h264',
          audioCodec: finalExportDetail!.outputAudioCodec as 'aac',
          container: finalExportDetail!.outputContainer as 'mp4',
          quality: finalExportDetail!.outputQuality as 'final',
        },
        approval: {
          actorType: finalExportDetail!.approvedByType as 'api-client' | 'user',
          actorId: finalExportDetail!.approvedById,
          approvedAt: finalExportDetail!.approvedAt.toISOString(),
          ...(finalExportDetail!.approvalNote ? { note: finalExportDetail!.approvalNote } : {}),
        },
        originalFileName: finalExportDetail!.originalFileName,
      } : isSourceCleanup ? {
        kind: 'source-cleanup' as const,
        projectId: sourceCleanupDetail!.projectId,
        cleanupPlanId: sourceCleanupDetail!.id,
        cleanupPlanHash: sourceCleanupDetail!.planHash,
        sourceArtifactId: sourceCleanupDetail!.sourceArtifactId,
        sourceArtifactSha256:
          sourceCleanupDetail!.sourceArtifactSha256,
        sourceManifestId: sourceCleanupDetail!.sourceManifestId,
        outputArtifactId: sourceCleanupDetail!.outputArtifactId!,
        outputManifestId: sourceCleanupDetail!.outputManifestId!,
        strategy: sourceCleanupDetail!.selectedStrategy as
          'trim' | 'crop-reframe' | 'cover',
      } : {
        kind: 'long-form-index' as const,
        projectId: longFormDetail!.projectId,
        workflowId: longFormDetail!.id,
        sourceArtifactId: longFormDetail!.sourceArtifactId,
        sourceManifestId: longFormDetail!.sourceManifestId,
      }),
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored PublicOperation failed integrity validation',
      { operationId: row.id },
    )
  }
}

function hydrateClaim(row: StoredOperation): ClaimedPublicOperationRecord {
  const record = hydrateRecord(row)
  if (
    row.status !== 'running' ||
    row.leaseOwner === null ||
    row.leaseExpiresAt === null ||
    row.heartbeatAt === null
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Claimed PublicOperation lease is missing')
  }
  return Object.freeze({
    ...record,
    lease: Object.freeze({
      owner: row.leaseOwner,
      attempt: row.attempt,
      heartbeatAt: row.heartbeatAt.toISOString(),
      expiresAt: row.leaseExpiresAt.toISOString(),
    }),
  })
}

export class PrismaPublicOperationRepository implements PublicOperationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async cancel(input: {
    workspaceId: string
    operationId: string
    canceledAt: string
  }): Promise<PublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.workspaceId) || !ID_PATTERN.test(input.operationId)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Cancellation target is invalid')
    }
    const canceledAt = parseCommandDate(input.canceledAt, 'canceledAt')
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const current = hydrateRecord(stored)
      const canceled = cancelPublicOperation(current.operation, canceledAt.toISOString())
      if (canceled.status !== 'canceled' || stored.status === 'canceled') return current

      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: { in: ['queued', 'running', 'waiting', 'retrying'] },
          cancelable: true,
        },
        data: {
          status: canceled.status,
          phase: canceled.phase,
          cancelable: false,
          retryable: false,
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          completedAt: canceledAt,
          nextAttemptAt: null,
          deadLetteredAt: null,
          updatedAt: canceledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      const persisted = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!persisted) return null
      const result = hydrateRecord(persisted)
      if (updated.count === 1 || result.operation.status === 'canceled') return result
      if (isTerminalPublicOperation(result.operation)) return result
      throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation cancellation collided')
    })
  }

  async retry(input: {
    workspaceId: string
    operationId: string
    requestedAt: string
    nextAttemptAt: string
  }): Promise<PublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.workspaceId) || !ID_PATTERN.test(input.operationId)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Retry target is invalid')
    }
    const requestedAt = parseCommandDate(input.requestedAt, 'requestedAt')
    const nextAttemptAt = parseCommandDate(input.nextAttemptAt, 'nextAttemptAt')
    if (nextAttemptAt.getTime() <= requestedAt.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Retry availability is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const current = hydrateRecord(stored)
      const retried = retryPublicOperation(
        current.operation,
        requestedAt.toISOString(),
        nextAttemptAt.toISOString(),
      )
      if (retried.status === stored.status) return current

      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: stored.status,
          updatedAt: stored.updatedAt,
        },
        data: {
          status: retried.status,
          phase: retried.phase,
          cancelable: retried.cancelable,
          retryable: retried.retryable,
          maxAttempts: retried.maxAttempts,
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          startedAt: retried.startedAt ? new Date(retried.startedAt) : null,
          completedAt: null,
          nextAttemptAt: retried.nextAttemptAt ? new Date(retried.nextAttemptAt) : null,
          deadLetteredAt: null,
          updatedAt: requestedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      const persisted = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!persisted) return null
      const result = hydrateRecord(persisted)
      if (updated.count === 1 || !isTerminalPublicOperation(result.operation)) return result
      throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation retry collided')
    })
  }

  private findStoredById(
    workspaceId: string,
    operationId: string,
  ): Promise<StoredOperation | null> {
    return this.client.v2PublicOperation.findFirst({
      where: { id: operationId, workspaceId },
      include: OPERATION_INCLUDE,
    })
  }

  async findById(
    workspaceId: string,
    operationId: string,
  ): Promise<PublicOperationRecord | null> {
    const stored = await this.findStoredById(workspaceId, operationId)
    return stored ? hydrateRecord(stored) : null
  }

  async list(input: PublicOperationListQuery): Promise<readonly PublicOperationRecord[]> {
    if (
      !ID_PATTERN.test(input.workspaceId) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101 ||
      (input.projectId !== undefined && !ID_PATTERN.test(input.projectId)) ||
      (input.targetId !== undefined && !ID_PATTERN.test(input.targetId))
    ) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Operation list query is invalid')
    }
    const afterDate = input.after
      ? parseCommandDate(input.after.createdAt, 'after.createdAt')
      : undefined
    if (input.after && !ID_PATTERN.test(input.after.id)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Operation cursor is invalid')
    }
    const where: Prisma.V2PublicOperationWhereInput = {
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.deadLettered === true
        ? { deadLetteredAt: { not: null } }
        : input.deadLettered === false
          ? { deadLetteredAt: null }
          : {}),
      ...(input.after && afterDate
        ? {
            OR: [
              { createdAt: { lt: afterDate } },
              { createdAt: afterDate, id: { lt: input.after.id } },
            ],
          }
        : {}),
    }
    const rows = await this.client.v2PublicOperation.findMany({
      where,
      include: OPERATION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return rows.map(hydrateRecord)
  }

  private findStoredReplay(
    workspaceId: string,
    clientId: string,
    idempotencyKey: string,
  ): Promise<StoredOperation | null> {
    return this.client.v2PublicOperation.findUnique({
      where: {
        workspaceId_clientId_idempotencyKey: {
          workspaceId,
          clientId,
          idempotencyKey,
        },
      },
      include: OPERATION_INCLUDE,
    })
  }

  async findReplay(input: {
    workspaceId: string
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult | null> {
    const stored = await this.findStoredReplay(
      input.workspaceId,
      input.clientId,
      input.idempotencyKey,
    )
    if (!stored) return null
    if (stored.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different request',
        { operationId: stored.id },
      )
    }
    return { ...hydrateRecord(stored), replayed: true }
  }

  async createOrReplay(input: {
    operation: PublicOperation
    context: PublicOperationCreationContext
    idempotencyKey: string
    requestFingerprint: string
    traceId?: string
  }, serializationAttempt = 1): Promise<PublicOperationPersistenceResult> {
    assertPublicOperation(input.operation)
    const renderContext = input.operation.type === 'artifact-render' && 'authorizationId' in input.context
      ? input.context
      : undefined
    const ingestContext = input.operation.type === 'media-ingest' && 'uploadId' in input.context
      ? input.context
      : undefined
    const projectRenderContext = input.operation.type === 'project-proxy-render' && input.context.kind === 'project-proxy-render'
      ? input.context
      : undefined
    const projectReuseContext = input.operation.type === 'project-proxy-render' && input.context.kind === 'project-proxy-reuse'
      ? input.context
      : undefined
    const finalExportContext = input.operation.type === 'project-final-export' && input.context.kind === 'project-final-export'
      ? input.context
      : undefined
    if (
      !(
        (input.operation.status === 'queued' && !projectReuseContext) ||
        (input.operation.status === 'succeeded' && Boolean(projectReuseContext))
      ) || !SHA256_PATTERN.test(input.requestFingerprint) ||
      (input.traceId !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(input.traceId)) ||
      (!renderContext && !ingestContext && !projectRenderContext && !projectReuseContext && !finalExportContext) ||
      (renderContext && (input.operation.projectId !== undefined || !SHA256_PATTERN.test(renderContext.inputHash) || !ID_PATTERN.test(renderContext.authorizationId))) ||
      (ingestContext && (
        input.operation.projectId !== ingestContext.projectId ||
        !/^[0-9a-f-]{36}$/.test(ingestContext.uploadId) ||
        ![ingestContext.projectId, ingestContext.sourceArtifactId, ingestContext.sourceManifestId].every((value) => ID_PATTERN.test(value)) ||
        ingestContext.sourceArtifactId !== input.operation.target.id || ingestContext.sourceManifestId !== input.operation.target.manifestId ||
        ingestContext.originalFileName.trim().length < 1 || ingestContext.originalFileName.length > 240
      )) ||
      (projectRenderContext && (
        input.operation.projectId !== projectRenderContext.projectId ||
        ![projectRenderContext.projectId, projectRenderContext.projectVersionId, projectRenderContext.editPlanSnapshotId,
          projectRenderContext.sourceArtifactId, projectRenderContext.sourceManifestId,
          projectRenderContext.outputArtifactId, projectRenderContext.outputManifestId].every((value) => ID_PATTERN.test(value)) ||
        !SHA256_PATTERN.test(projectRenderContext.inputHash) ||
        !validColorPipelineBindings(projectRenderContext.colorPipelineBindings) ||
        projectRenderContext.outputArtifactId !== input.operation.target.id ||
        projectRenderContext.outputManifestId !== input.operation.target.manifestId ||
        projectRenderContext.originalFileName.trim().length < 1 || projectRenderContext.originalFileName.length > 240
      )) ||
      (projectReuseContext && (
        input.operation.projectId !== projectReuseContext.projectId ||
        ![
          projectReuseContext.projectId, projectReuseContext.projectVersionId,
          projectReuseContext.editPlanSnapshotId, projectReuseContext.commandId,
          projectReuseContext.baseVersionId, projectReuseContext.reusedFromOperationId,
          projectReuseContext.sourceArtifactId, projectReuseContext.sourceManifestId,
          projectReuseContext.outputArtifactId, projectReuseContext.outputManifestId,
        ].every((value) => ID_PATTERN.test(value)) ||
        !SHA256_PATTERN.test(projectReuseContext.impactHash) ||
        !SHA256_PATTERN.test(projectReuseContext.inputHash) ||
        projectReuseContext.outputArtifactId !== input.operation.target.id ||
        projectReuseContext.outputManifestId !== input.operation.target.manifestId ||
        projectReuseContext.originalFileName.trim().length < 1 ||
        projectReuseContext.originalFileName.length > 240
      )) ||
      (finalExportContext && (
        input.operation.projectId !== finalExportContext.projectId ||
        ![finalExportContext.projectId, finalExportContext.projectVersionId, finalExportContext.editPlanSnapshotId,
          finalExportContext.directorRunId, finalExportContext.qualitySnapshotId,
          finalExportContext.proxyReviewId, finalExportContext.proxyArtifactId,
          finalExportContext.sourceArtifactId, finalExportContext.sourceManifestId,
          finalExportContext.outputArtifactId, finalExportContext.outputManifestId,
          finalExportContext.approval.actorId].every((value) => ID_PATTERN.test(value)) ||
        ![finalExportContext.projectVersionHash, finalExportContext.qualitySnapshotHash,
          finalExportContext.proxyReviewHash, finalExportContext.inputHash].every((value) => SHA256_PATTERN.test(value)) ||
        !validColorPipelineBindings(finalExportContext.colorPipelineBindings) ||
        finalExportContext.outputArtifactId !== input.operation.target.id ||
        finalExportContext.outputManifestId !== input.operation.target.manifestId ||
        !['9:16', '16:9', '4:5', '1:1', '21:9'].includes(finalExportContext.outputSpec.aspectRatio) ||
        ![finalExportContext.outputSpec.width, finalExportContext.outputSpec.height, finalExportContext.outputSpec.fps].every((value) => Number.isSafeInteger(value) && value > 0) ||
        finalExportContext.outputSpec.width % 2 !== 0 || finalExportContext.outputSpec.height % 2 !== 0 ||
        finalExportContext.outputSpec.codec !== 'h264' ||
        finalExportContext.outputSpec.audioCodec !== 'aac' ||
        finalExportContext.outputSpec.container !== 'mp4' ||
        finalExportContext.outputSpec.quality !== 'final' ||
        finalExportContext.approval.actorType !== 'api-client' || Number.isNaN(Date.parse(finalExportContext.approval.approvedAt)) ||
        (finalExportContext.approval.note !== undefined && (finalExportContext.approval.note.length < 1 || finalExportContext.approval.note.length > 1000)) ||
        finalExportContext.originalFileName.trim().length < 1 || finalExportContext.originalFileName.length > 240
      )) ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 128
    ) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Queued operation persistence input is invalid')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2PublicOperation.findUnique({
          where: {
            workspaceId_clientId_idempotencyKey: {
              workspaceId: input.operation.workspaceId,
              clientId: input.operation.clientId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: OPERATION_INCLUDE,
        })
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
              { operationId: existing.id },
            )
          }
          return { ...hydrateRecord(existing), replayed: true }
        }

        let reusedColorPipelineBindingsJson: string | undefined
        if (ingestContext) {
          const upload = await transaction.v2MediaUpload.findFirst({
            where: {
              id: ingestContext.uploadId,
              workspaceId: input.operation.workspaceId,
              clientId: input.operation.clientId,
              projectId: ingestContext.projectId,
              status: 'verified',
              rightsConfirmed: true,
            },
            select: { id: true, fileName: true },
          })
          if (!upload || upload.fileName !== ingestContext.originalFileName) {
            throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Verified upload cannot be attached to this ingest operation')
          }
        }
        if (projectRenderContext) {
          const [source, colorPipelines] = await Promise.all([transaction.v2Project.findFirst({
            where: { id: projectRenderContext.projectId, workspaceId: input.operation.workspaceId },
            include: {
              versions: {
                where: { id: projectRenderContext.projectVersionId, editPlanSnapshotId: projectRenderContext.editPlanSnapshotId },
                take: 1,
              },
              mediaAssets: {
                where: { artifactId: projectRenderContext.sourceArtifactId, role: 'source-master' },
                include: { artifact: { include: { manifests: { where: { id: projectRenderContext.sourceManifestId }, take: 1 } } } },
                take: 1,
              },
            },
          }), transaction.v2ColorPipelineCompilation.findMany({
            where: { workspaceId: input.operation.workspaceId, projectId: projectRenderContext.projectId,
              id: { in: projectRenderContext.colorPipelineBindings.map((binding) => binding.compilationId) } },
            select: { id: true, sourceArtifactId: true, sourceManifestId: true, compilationHash: true, pipelineHash: true },
          })])
          if (!source || source.versions.length !== 1 || source.mediaAssets.length !== 1 || source.mediaAssets[0]!.artifact.manifests.length !== 1 ||
            colorPipelines.length !== projectRenderContext.colorPipelineBindings.length ||
            projectRenderContext.colorPipelineBindings.some((binding) => !colorPipelines.some((row) =>
              row.id === binding.compilationId && row.sourceArtifactId === binding.sourceArtifactId &&
              row.sourceManifestId === binding.sourceManifestId && row.compilationHash === binding.compilationHash &&
              row.pipelineHash === binding.pipelineHash))) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy render source is not immutable and available')
          }
        }
        if (projectReuseContext) {
          const [version, reusedOperation, artifact, manifest] = await Promise.all([
            transaction.v2ProjectVersion.findFirst({
              where: {
                id: projectReuseContext.projectVersionId,
                workspaceId: input.operation.workspaceId,
                projectId: projectReuseContext.projectId,
                editPlanSnapshotId: projectReuseContext.editPlanSnapshotId,
                currentForProjects: {
                  some: {
                    id: projectReuseContext.projectId,
                    workspaceId: input.operation.workspaceId,
                  },
                },
              },
              include: { command: true },
            }),
            transaction.v2ProjectProxyRenderOperation.findFirst({
              where: {
                operationId: projectReuseContext.reusedFromOperationId,
                workspaceId: input.operation.workspaceId,
                projectId: projectReuseContext.projectId,
                projectVersionId: projectReuseContext.baseVersionId,
                sourceArtifactId: projectReuseContext.sourceArtifactId,
                sourceManifestId: projectReuseContext.sourceManifestId,
                outputArtifactId: projectReuseContext.outputArtifactId,
                outputManifestId: projectReuseContext.outputManifestId,
                operation: { status: 'succeeded', phase: 'completed' },
              },
              select: { colorPipelineBindingsJson: true },
            }),
            transaction.v2MediaArtifact.findFirst({
              where: {
                id: projectReuseContext.outputArtifactId,
                workspaceId: input.operation.workspaceId,
                status: 'available',
              },
              select: { id: true },
            }),
            transaction.v2MediaArtifactManifest.findFirst({
              where: {
                id: projectReuseContext.outputManifestId,
                workspaceId: input.operation.workspaceId,
                artifactId: projectReuseContext.outputArtifactId,
              },
              select: { id: true },
            }),
          ])
          const impact = version?.command
            ? parseStoredCommandImpact(version.command.payloadJson)
            : undefined
          if (
            !version || !version.command || !reusedOperation || !artifact || !manifest || !impact ||
            version.parentVersionId !== projectReuseContext.baseVersionId ||
            version.command.id !== projectReuseContext.commandId ||
            version.command.type !== 'manual-edit' ||
            version.command.baseVersionId !== projectReuseContext.baseVersionId ||
            impact.commandId !== projectReuseContext.commandId ||
            impact.baseVersionId !== projectReuseContext.baseVersionId ||
            impact.resultVersionId !== projectReuseContext.projectVersionId ||
            impact.impactHash !== projectReuseContext.impactHash ||
            impact.renderSemanticsChanged || impact.changeKinds.length !== 1 ||
            impact.changeKinds[0] !== 'selection' || impact.affectedArtifacts.length !== 0 ||
            impact.minimalRenders.length !== 0
          ) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Project proxy reuse is not bound to an unchanged immutable Command and completed base proxy',
            )
          }
          parseColorPipelineBindings(reusedOperation.colorPipelineBindingsJson)
          reusedColorPipelineBindingsJson = reusedOperation.colorPipelineBindingsJson
        }
        if (finalExportContext) {
          const [source, colorPipelines] = await Promise.all([transaction.v2Project.findFirst({
            where: {
              id: finalExportContext.projectId,
              workspaceId: input.operation.workspaceId,
              currentVersionId: finalExportContext.projectVersionId,
            },
            include: {
              versions: {
                where: {
                  id: finalExportContext.projectVersionId,
                  baseHash: finalExportContext.projectVersionHash,
                  editPlanSnapshotId: finalExportContext.editPlanSnapshotId,
                },
                take: 1,
              },
              directorRuns: {
                where: {
                  id: finalExportContext.directorRunId,
                  resultVersionId: finalExportContext.projectVersionId,
                  qualitySnapshotId: finalExportContext.qualitySnapshotId,
                  status: 'succeeded',
                },
                include: { qualitySnapshot: true },
                take: 1,
              },
              proxyReviews: {
                where: {
                  id: finalExportContext.proxyReviewId,
                  projectVersionId: finalExportContext.projectVersionId,
                  reviewHash: finalExportContext.proxyReviewHash,
                  proxyArtifactId: finalExportContext.proxyArtifactId,
                  status: 'ready-for-final',
                  finalAllowed: true,
                },
                take: 1,
              },
              mediaAssets: {
                where: { artifactId: finalExportContext.sourceArtifactId, role: 'source-master' },
                include: { artifact: { include: { manifests: { where: { id: finalExportContext.sourceManifestId }, take: 1 } } } },
                take: 1,
              },
            },
          }), transaction.v2ColorPipelineCompilation.findMany({
            where: { workspaceId: input.operation.workspaceId, projectId: finalExportContext.projectId,
              id: { in: finalExportContext.colorPipelineBindings.map((binding) => binding.compilationId) } },
            select: { id: true, sourceArtifactId: true, sourceManifestId: true, compilationHash: true, pipelineHash: true },
          })])
          if (
            !source || source.versions.length !== 1 || source.directorRuns.length !== 1 ||
            source.proxyReviews.length !== 1 || source.mediaAssets.length !== 1 ||
            source.mediaAssets[0]!.artifact.manifests.length !== 1 ||
            source.directorRuns[0]!.qualitySnapshot.contentHash !== finalExportContext.qualitySnapshotHash ||
            colorPipelines.length !== finalExportContext.colorPipelineBindings.length ||
            finalExportContext.colorPipelineBindings.some((binding) => !colorPipelines.some((row) =>
              row.id === binding.compilationId && row.sourceArtifactId === binding.sourceArtifactId &&
              row.sourceManifestId === binding.sourceManifestId && row.compilationHash === binding.compilationHash &&
              row.pipelineHash === binding.pipelineHash))
          ) {
            throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'Final export source, DirectorRun or QualityReport is no longer current and approved')
          }
        }

        await transaction.v2PublicOperation.create({
          data: {
            id: input.operation.id,
            workspaceId: input.operation.workspaceId,
            projectId: input.operation.projectId,
            clientId: input.operation.clientId,
            type: input.operation.type,
            status: input.operation.status,
            phase: input.operation.phase,
            targetType: input.operation.target.type,
            targetId: input.operation.target.id,
            progressCompleted: input.operation.progress?.completed,
            progressTotal: input.operation.progress?.total,
            progressUnit: input.operation.progress?.unit,
            cancelable: input.operation.cancelable,
            retryable: input.operation.retryable,
            attempt: input.operation.attempt,
            maxAttempts: input.operation.maxAttempts,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            traceId: input.traceId,
            createdAt: new Date(input.operation.createdAt),
            updatedAt: new Date(input.operation.updatedAt),
            ...(input.operation.result ? { resultJson: stableSerialize(input.operation.result) } : {}),
            ...(input.operation.startedAt ? { startedAt: new Date(input.operation.startedAt) } : {}),
            ...(input.operation.completedAt ? { completedAt: new Date(input.operation.completedAt) } : {}),
          },
        })
        if (renderContext) {
          await transaction.v2ArtifactRenderOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              artifactId: input.operation.target.id,
              manifestId: input.operation.target.manifestId,
              authorizationId: renderContext.authorizationId,
              inputHash: renderContext.inputHash,
            },
          })
        } else if (ingestContext) {
          await transaction.v2MediaIngestOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              uploadId: ingestContext!.uploadId,
              projectId: ingestContext!.projectId,
              sourceArtifactId: ingestContext!.sourceArtifactId,
              sourceManifestId: ingestContext!.sourceManifestId,
              originalFileName: ingestContext!.originalFileName,
            },
          })
          const project = await transaction.v2Project.updateMany({
            where: {
              id: ingestContext!.projectId,
              workspaceId: input.operation.workspaceId,
              status: { in: projectStatusTransitionSources('ingesting') },
            },
            data: { status: 'ingesting' },
          })
          if (project.count !== 1) {
            throw new DomainError('PROJECT_TRANSITION_REJECTED', 'Project cannot enter ingesting from its current status')
          }
        } else if (projectRenderContext || projectReuseContext) {
          const context = projectRenderContext ?? projectReuseContext!
          await transaction.v2ProjectProxyRenderOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              projectId: context.projectId,
              projectVersionId: context.projectVersionId,
              editPlanSnapshotId: context.editPlanSnapshotId,
              sourceArtifactId: context.sourceArtifactId,
              sourceManifestId: context.sourceManifestId,
              colorPipelineBindingsJson: projectRenderContext
                ? stableSerialize(projectRenderContext.colorPipelineBindings)
                : reusedColorPipelineBindingsJson!,
              inputHash: context.inputHash,
              outputArtifactId: context.outputArtifactId,
              outputManifestId: context.outputManifestId,
              originalFileName: context.originalFileName,
              ...(projectReuseContext ? {
                reusedFromOperationId: projectReuseContext.reusedFromOperationId,
                reuseCommandId: projectReuseContext.commandId,
                reuseImpactHash: projectReuseContext.impactHash,
                reuseBaseVersionId: projectReuseContext.baseVersionId,
              } : {}),
            },
          })
        } else {
          await transaction.v2ProjectFinalExportOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              projectId: finalExportContext!.projectId,
              projectVersionId: finalExportContext!.projectVersionId,
              projectVersionHash: finalExportContext!.projectVersionHash,
              editPlanSnapshotId: finalExportContext!.editPlanSnapshotId,
              directorRunId: finalExportContext!.directorRunId,
              qualitySnapshotId: finalExportContext!.qualitySnapshotId,
              qualitySnapshotHash: finalExportContext!.qualitySnapshotHash,
              proxyReviewId: finalExportContext!.proxyReviewId,
              proxyReviewHash: finalExportContext!.proxyReviewHash,
              proxyArtifactId: finalExportContext!.proxyArtifactId,
              sourceArtifactId: finalExportContext!.sourceArtifactId,
              sourceManifestId: finalExportContext!.sourceManifestId,
              colorPipelineBindingsJson: stableSerialize(finalExportContext!.colorPipelineBindings),
              inputHash: finalExportContext!.inputHash,
              outputArtifactId: finalExportContext!.outputArtifactId,
              outputManifestId: finalExportContext!.outputManifestId,
              outputAspectRatio: finalExportContext!.outputSpec.aspectRatio,
              outputWidth: finalExportContext!.outputSpec.width,
              outputHeight: finalExportContext!.outputSpec.height,
              outputFps: finalExportContext!.outputSpec.fps,
              outputCodec: finalExportContext!.outputSpec.codec,
              outputAudioCodec: finalExportContext!.outputSpec.audioCodec,
              outputContainer: finalExportContext!.outputSpec.container,
              outputQuality: finalExportContext!.outputSpec.quality,
              approvedByType: finalExportContext!.approval.actorType,
              approvedById: finalExportContext!.approval.actorId,
              approvalNote: finalExportContext!.approval.note,
              approvedAt: new Date(finalExportContext!.approval.approvedAt),
              originalFileName: finalExportContext!.originalFileName,
            },
          })
          const project = await transaction.v2Project.updateMany({
            where: {
              id: finalExportContext!.projectId,
              workspaceId: input.operation.workspaceId,
              currentVersionId: finalExportContext!.projectVersionId,
              status: { in: projectStatusTransitionPath('reviewing-proxy', 'rendering-final') },
            },
            data: { status: 'rendering-final' },
          })
          if (project.count !== 1) {
            throw new DomainError('PROJECT_TRANSITION_REJECTED', 'Project cannot enter final rendering from its current status')
          }
        }
        const created = await transaction.v2PublicOperation.findUnique({
          where: { id: input.operation.id },
          include: OPERATION_INCLUDE,
        })
        if (!created) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation was not persisted')
        }
        return { ...hydrateRecord(created), replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.createOrReplay(input, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'PublicOperation creation conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const replay = await this.findReplay({
          workspaceId: input.operation.workspaceId,
          clientId: input.operation.clientId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        })
        if (replay) return replay
      }
      throw error
    }
  }

  async claimNext(input: {
    leaseOwner: string
    now: string
    leaseUntil: string
    workspaceId?: string
    type?: PublicOperation['type']
  }): Promise<ClaimedPublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.leaseOwner)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease owner is invalid')
    }
    const now = parseCommandDate(input.now, 'now')
    const leaseUntil = parseCommandDate(input.leaseUntil, 'leaseUntil')
    if (leaseUntil.getTime() <= now.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease must expire after now')
    }

    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2PublicOperation.findMany({
        where: {
          ...(input.type ? { type: input.type } : {}),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          OR: [
            { status: 'queued', leaseOwner: null },
            {
              status: 'retrying',
              leaseOwner: null,
              nextAttemptAt: { lte: now },
            },
            { status: 'running', leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 32,
        include: OPERATION_INCLUDE,
      })
      for (const candidate of candidates) {
        const current = hydrateRecord(candidate).operation
        if (candidate.attempt >= candidate.maxAttempts) {
          if (candidate.status === 'running') {
            await transaction.v2PublicOperation.updateMany({
              where: {
                id: candidate.id,
                status: 'running',
                phase: candidate.phase,
                attempt: candidate.attempt,
                updatedAt: candidate.updatedAt,
                leaseOwner: candidate.leaseOwner,
                leaseExpiresAt: { lte: now },
              },
              data: {
                status: 'failed',
                phase: 'failed',
                cancelable: false,
                retryable: false,
                resultJson: null,
                errorCode: 'worker_lease_expired',
                errorMessage: 'Operation exhausted its available attempts',
                errorRetryable: false,
                completedAt: now,
                nextAttemptAt: null,
                deadLetteredAt: now,
                updatedAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
              },
            })
          }
          continue
        }
        const claimed = startPublicOperationAttempt(current, now.toISOString())
        const updated = await transaction.v2PublicOperation.updateMany({
          where: {
            id: candidate.id,
            status: candidate.status,
            phase: candidate.phase,
            attempt: candidate.attempt,
            updatedAt: candidate.updatedAt,
            ...(candidate.status === 'running'
              ? {
                  leaseOwner: candidate.leaseOwner,
                  leaseExpiresAt: { lte: now },
                }
              : { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null }),
          },
          data: {
            status: claimed.status,
            phase: claimed.phase,
            progressCompleted: claimed.progress?.completed,
            progressTotal: claimed.progress?.total,
            progressUnit: claimed.progress?.unit,
            cancelable: claimed.cancelable,
            retryable: claimed.retryable,
            attempt: claimed.attempt,
            resultJson: null,
            errorCode: null,
            errorMessage: null,
            errorRetryable: null,
            startedAt: new Date(claimed.startedAt as string),
            completedAt: null,
            nextAttemptAt: null,
            deadLetteredAt: null,
            updatedAt: now,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: leaseUntil,
            heartbeatAt: now,
          },
        })
        if (updated.count !== 1) continue
        const stored = await transaction.v2PublicOperation.findUnique({
          where: { id: candidate.id },
          include: OPERATION_INCLUDE,
        })
        if (!stored) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Claimed PublicOperation disappeared')
        }
        return hydrateClaim(stored)
      }
      return null
    })
  }

  async heartbeat(input: PublicOperationLeaseCommand & {
    leaseUntil: string
  }): Promise<boolean> {
    const now = parseCommandDate(input.now, 'now')
    const leaseUntil = parseCommandDate(input.leaseUntil, 'leaseUntil')
    if (!ID_PATTERN.test(input.leaseOwner) || leaseUntil.getTime() <= now.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Heartbeat lease input is invalid')
    }
    const updated = await this.client.v2PublicOperation.updateMany({
      where: {
        id: input.operationId,
        status: 'running',
        leaseOwner: input.leaseOwner,
        attempt: input.attempt,
        leaseExpiresAt: { gt: now },
        heartbeatAt: { lte: now },
        updatedAt: { lte: now },
      },
      data: { heartbeatAt: now, leaseExpiresAt: leaseUntil, updatedAt: now },
    })
    return updated.count === 1
  }

  private async transitionRunning(
    input: PublicOperationLeaseCommand,
    transition: (operation: PublicOperation) => Readonly<PublicOperation>,
    requiresCheckpoint = false,
  ): Promise<PublicOperationRecord | null> {
    const now = parseCommandDate(input.now, 'now')
    if (!ID_PATTERN.test(input.leaseOwner)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease owner is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const record = hydrateRecord(stored)
      if (
        stored.status !== 'running' ||
        stored.leaseOwner !== input.leaseOwner ||
        stored.attempt !== input.attempt ||
        stored.leaseExpiresAt === null ||
        stored.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return null
      }
      if (
        requiresCheckpoint &&
        requiresArtifactRenderCheckpoint(stored.type as PublicOperation['type']) &&
        (!stored.artifactRender || !hasCompleteCheckpoint(stored.artifactRender))
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Render operation cannot succeed before its output checkpoint',
        )
      }
      const next = transition(record.operation)
      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          status: 'running',
          phase: stored.phase,
          updatedAt: stored.updatedAt,
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
        },
        data: {
          status: next.status,
          phase: next.phase,
          progressCompleted: next.progress?.completed,
          progressTotal: next.progress?.total,
          progressUnit: next.progress?.unit,
          cancelable: next.cancelable,
          retryable: next.retryable,
          resultJson: next.result ? JSON.stringify(next.result) : null,
          errorCode: next.error?.code ?? null,
          errorMessage: next.error?.message ?? null,
          errorRetryable: next.error?.retryable ?? null,
          completedAt: next.completedAt ? new Date(next.completedAt) : null,
          nextAttemptAt: next.nextAttemptAt ? new Date(next.nextAttemptAt) : null,
          deadLetteredAt: next.deadLetteredAt ? new Date(next.deadLetteredAt) : null,
          updatedAt: now,
          ...(next.status === 'running'
            ? {}
            : { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null }),
        },
      })
      if (updated.count !== 1) return null
      const persisted = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      return persisted ? hydrateRecord(persisted) : null
    })
  }

  async advancePhase(input: PublicOperationLeaseCommand & {
    phase: PublicOperationRunningPhase
  }): Promise<boolean> {
    const record = await this.transitionRunning(input, (operation) =>
      advancePublicOperationPhase(operation, input.phase, input.now),
    )
    return record !== null
  }

  wait(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(input, (operation) =>
      waitPublicOperation(operation, input.now),
    )
  }

  async resumeWaiting(
    input: ResumeWaitingPublicOperationCommand,
  ): Promise<ClaimedPublicOperationRecord | null> {
    const now = parseCommandDate(input.now, 'now')
    const leaseUntil = parseCommandDate(input.leaseUntil, 'leaseUntil')
    if (!ID_PATTERN.test(input.leaseOwner) || leaseUntil.getTime() <= now.getTime()) {
      throw new DomainError(
        'INVALID_PUBLIC_OPERATION',
        'Waiting operation resume lease input is invalid',
      )
    }
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const record = hydrateRecord(stored)
      if (
        stored.status !== 'waiting' ||
        stored.phase !== 'waiting' ||
        stored.attempt !== input.attempt
      ) {
        return null
      }
      const resumed = resumeWaitingPublicOperation(
        record.operation,
        input.phase,
        input.now,
      )
      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: 'waiting',
          phase: 'waiting',
          attempt: input.attempt,
          updatedAt: stored.updatedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
        data: {
          status: resumed.status,
          phase: resumed.phase,
          progressCompleted: resumed.progress?.completed,
          progressTotal: resumed.progress?.total,
          progressUnit: resumed.progress?.unit,
          cancelable: resumed.cancelable,
          retryable: resumed.retryable,
          updatedAt: now,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: leaseUntil,
          heartbeatAt: now,
        },
      })
      if (updated.count !== 1) return null
      const persisted = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      return persisted ? hydrateClaim(persisted) : null
    })
  }

  succeed(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(
      input,
      (operation) => succeedPublicOperation(operation, input.now),
      true,
    )
  }

  failOrRetry(input: PublicOperationLeaseCommand & {
    error: PublicOperationError
    nextAttemptAt?: string
  }): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(input, (operation) =>
      retryOrFailPublicOperation(operation, input.error, input.now, input.nextAttemptAt),
    )
  }
}
